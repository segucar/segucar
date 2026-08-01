require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let dbPath = path.join(dataDir, 'gestionseguro.db');

const seedPath = path.join(__dirname, 'seed.db');
if (fs.existsSync(seedPath)) {
    let forceSeed = false;
    if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size < 50000) {
        forceSeed = true;
    } else {
        try {
            const checkDb = new Database(dbPath);
            const countGestiones = checkDb.prepare("SELECT COUNT(*) as c FROM historial_gestiones_whatsapp").get();
            if (!countGestiones || countGestiones.c === 0) {
                forceSeed = true;
            }
            checkDb.close();
        } catch (e) {
            forceSeed = true;
        }
    }

    if (forceSeed) {
        try {
            fs.copyFileSync(seedPath, dbPath);
            console.log('✅ Base de datos inicial sembrada con métricas desde seed.db.');
        } catch (e) {
            console.error('Error sembrando seed.db:', e);
        }
    }
}

if (process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT) {
    const tmpPath = path.join('/tmp', 'gestionseguro.db');
    if (!fs.existsSync(tmpPath) && fs.existsSync(dbPath)) {
        try { fs.copyFileSync(dbPath, tmpPath); } catch(e){}
    }
    if (fs.existsSync(tmpPath)) dbPath = tmpPath;
}

const db = new Database(dbPath);

// Habilitar WAL mode para mejor performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Crear tablas ───────────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        dni TEXT,
        direccion TEXT,
        telefono TEXT,
        email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS polizas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        operacion TEXT UNIQUE,
        seccion INTEGER,
        tipo_vehiculo TEXT,
        patente TEXT,
        vehiculo TEXT,
        suma_asegurada TEXT,
        cod_prod TEXT,
        cuenta TEXT,
        fecha_vencimiento DATE,
        renovada TEXT,
        cuotas_debe INTEGER,
        observaciones TEXT,
        estado TEXT DEFAULT 'vigente',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS polizas_historicas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        telefono TEXT,
        operacion TEXT UNIQUE,
        seccion INTEGER,
        tipo_vehiculo TEXT,
        patente TEXT,
        vehiculo TEXT,
        fecha_vencimiento DATE,
        estrategia TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contactos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        poliza_id INTEGER REFERENCES polizas(id),
        tipo TEXT,
        medio TEXT DEFAULT 'whatsapp',
        mensaje TEXT,
        fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plantillas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        mensaje TEXT NOT NULL,
        activa INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS contactos_telefono (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        telefono TEXT,
        importado_de TEXT DEFAULT 'vcf',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telefonos_maestros (
        cliente_id INTEGER PRIMARY KEY,
        nombre TEXT,
        telefono TEXT NOT NULL,
        origen TEXT DEFAULT 'scraper',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telefonos_invalidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        nombre TEXT,
        telefono TEXT NOT NULL,
        motivo TEXT DEFAULT 'numero_inexistente',
        reported_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS historial_gestiones_whatsapp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        poliza_id INTEGER REFERENCES polizas(id) ON DELETE SET NULL,
        tipo_plantilla TEXT NOT NULL,
        fecha_envio DATETIME DEFAULT CURRENT_TIMESTAMP,
        saldo_al_enviar REAL DEFAULT 0,
        estado_resultado TEXT DEFAULT 'pendiente',
        fecha_resolucion DATETIME NULL,
        dias_hasta_pago INTEGER NULL
    );
    CREATE TABLE IF NOT EXISTS cuotas_admin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poliza_id INTEGER REFERENCES polizas(id) ON DELETE CASCADE,
        numero_cuota INTEGER NOT NULL DEFAULT 1,
        monto_poliza REAL NOT NULL DEFAULT 0,
        monto_acarreo REAL NOT NULL DEFAULT 0,
        monto_total REAL NOT NULL DEFAULT 0,
        fecha_vencimiento DATE NOT NULL,
        estado TEXT DEFAULT 'PENDIENTE',
        mp_preference_id TEXT,
        comprobante_pdf_url TEXT,
        fecha_pago DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ─── Migraciones de Columnas para Auditar NRE ────────────────────────────────
const addColumn = (colName, colDef) => {
    try {
        db.exec(`ALTER TABLE polizas ADD COLUMN ${colName} ${colDef}`);
    } catch (e) {
        // Ignorar si la columna ya existe
    }
};
const addColumnCuotas = (colName, colDef) => {
    try {
        db.exec(`ALTER TABLE cuotas_admin ADD COLUMN ${colName} ${colDef}`);
    } catch (e) {
        // Column exists
    }
};
addColumnCuotas('pdf_nre_url', 'TEXT');
addColumnCuotas('pdf_grucar_url', 'TEXT');
addColumn('total_cuotas', 'INTEGER DEFAULT 3');
addColumn('saldo_pendiente', 'REAL DEFAULT 0');
addColumn('fin_vigencia_poliza', 'DATE');
addColumn('cuotas_historial', 'TEXT');
addColumn('fecha_vencimiento_grucar', 'DATE');
addColumn('grucar_activo', 'INTEGER DEFAULT 1');
addColumn('aseguradora', "TEXT DEFAULT 'SEGUCar / Triunvirato'");
addColumn('frecuencia_renovacion', "TEXT DEFAULT 'TRIMESTRAL'");

// ─── Seed plantillas por defecto ────────────────────────────────────────────

// Purge any old combined templates to guarantee clean single-variable templates
db.prepare("DELETE FROM plantillas WHERE tipo LIKE 'combinado%' OR nombre LIKE '%Combinado%'").run();

// Clean up {nombre} variable from all existing templates in DB
// Update default templates in DB to use poliza N° {operacion} (Patente {patente}) without marca/modelo
try {
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'recordatorio_48hs'").run(
        'Hola, ¿cómo estás? Te aviso que en 48 hs vence la cuota de tu póliza N° {operacion} (Patente {patente}). Escribinos si querés abonarla de manera virtual o te esperamos en cualquiera de nuestras oficinas. ¡Saludos!'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'primer_aviso'").run(
        'Hola, te recuerdo que la cuota de tu póliza N° {operacion} (Patente {patente}) venció hace 48 hs. Avisame si necesitás los datos de pago así te mantenemos la cobertura al día. ¡Gracias!'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'segundo_aviso'").run(
        'Hola, te informamos que la cuota de tu póliza N° {operacion} (Patente {patente}) venció hace 96 hs y finaliza tu período de gracia. Escribinos para regularizar la cuota antes de perder la cobertura.'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'mora_critica'").run(
        'Hola, te aviso que la cuota de tu póliza N° {operacion} (Patente {patente}) venció hace más de 4 días (o registrás cuotas impagas). La póliza perdió la cobertura. Escribinos urgente para regularizar tu situación.'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'renovacion_7_dias'").run(
        'Hola, ¿cómo estás? Te informamos que tu póliza N° {operacion} (Patente {patente}) se encuentra al día con los pagos y vence en 7 días. Avisame si querés renovarla así te preparamos la nueva cobertura con anticipación. ¡Un saludo!'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'renovacion_deuda'").run(
        'Hola, te informamos que en 7 días vence la renovación de tu póliza N° {operacion} (Patente {patente}). Para poder emitir la nueva póliza y mantener la cobertura, necesitamos regularizar el saldo pendiente de las cuotas impagas. Escribinos para enviarte el medio de pago. ¡Gracias!'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'poliza_vencida'").run(
        'Hola, te escribimos de SEGUCar para avisarte que tu póliza N° {operacion} (Patente {patente}) venció el {fecha_vencimiento}. ¿Querés que la renovemos así seguís circulando con tranquilidad y cobertura? Quedamos a tu disposición. ¡Un saludo!'
    );
    db.prepare("UPDATE plantillas SET mensaje = ? WHERE tipo = 'recuperacion_historica'").run(
        'Hola, te saludamos de SEGUCar. Queremos ponernos en contacto nuevamente por tu póliza N° {operacion} (Patente {patente}). Contamos con nuevas propuestas y excelentes coberturas para reactivar tu seguro. ¡Consultanos sin compromiso!'
    );
} catch (e) {
    console.error('Error actualizando plantillas sin vehiculo:', e);
}

db.guardarTelefonoMaestro = (cliente_id, nombre, telefono, origen = 'scraper') => {
    if (!cliente_id || !telefono || telefono.length < 10) return;
    try {
        db.prepare(`
            INSERT INTO telefonos_maestros (cliente_id, nombre, telefono, origen, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(cliente_id) DO UPDATE SET
                telefono = excluded.telefono,
                origen = excluded.origen,
                updated_at = CURRENT_TIMESTAMP
        `).run(cliente_id, nombre || '', telefono, origen);
    } catch (e) {
        console.error('Error guardando teléfono maestro:', e);
    }
};

db.restaurarTelefonosMaestros = () => {
    try {
        db.exec(`
            UPDATE clientes
            SET telefono = (SELECT telefono FROM telefonos_maestros WHERE cliente_id = clientes.id)
            WHERE (telefono IS NULL OR telefono = '' OR length(telefono) < 10)
              AND EXISTS (
                  SELECT 1 FROM telefonos_maestros 
                  WHERE cliente_id = clientes.id 
                    AND telefono IS NOT NULL 
                    AND length(telefono) >= 10
              )
              AND NOT EXISTS (
                  SELECT 1 FROM telefonos_invalidos
                  WHERE cliente_id = clientes.id
              );
        `);
    } catch (e) {
        console.error('Error al restaurar teléfonos maestros:', e);
    }
};

db.marcarTelefonoInvalido = (clienteId, motivo = 'numero_inexistente') => {
    if (!clienteId) return false;
    try {
        const client = db.prepare('SELECT id, nombre, telefono FROM clientes WHERE id = ?').get(clienteId);
        if (!client) return false;
        const currentTel = client.telefono || '';

        db.prepare(`
            INSERT INTO telefonos_invalidos (cliente_id, nombre, telefono, motivo, reported_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(client.id, client.nombre || '', currentTel, motivo);

        db.prepare("UPDATE clientes SET telefono = '' WHERE id = ?").run(client.id);
        db.prepare("DELETE FROM telefonos_maestros WHERE cliente_id = ?").run(client.id);

        return true;
    } catch (e) {
        console.error('Error marcando teléfono como inválido:', e);
        return false;
    }
};

db.evaluarAtribucionMetricas = () => {
    try {
        const activas = db.prepare(`
            SELECT * FROM historial_gestiones_whatsapp 
            WHERE estado_resultado IN ('pendiente', 'vencido_sin_pago')
              AND fecha_envio >= date('now', '-30 days', 'localtime')
        `).all();

        if (activas.length === 0) return;

        const checkPolizaSaldo = db.prepare("SELECT COALESCE(saldo_pendiente, 0) as saldo FROM polizas WHERE id = ?");
        const checkClienteSaldo = db.prepare("SELECT SUM(COALESCE(saldo_pendiente, 0)) as total_saldo FROM polizas WHERE cliente_id = ?");

        const updateGestion = db.prepare(`
            UPDATE historial_gestiones_whatsapp
            SET estado_resultado = ?,
                fecha_resolucion = CURRENT_TIMESTAMP,
                dias_hasta_pago = MAX(0, CAST(julianday(CURRENT_TIMESTAMP) - julianday(fecha_envio) AS INTEGER))
            WHERE id = ?
        `);

        db.transaction(() => {
            for (const g of activas) {
                let currentSaldo = 0;
                if (g.poliza_id) {
                    const polRes = checkPolizaSaldo.get(g.poliza_id);
                    currentSaldo = polRes ? parseFloat(polRes.saldo || 0) : 0;
                } else {
                    const saldoRes = checkClienteSaldo.get(g.cliente_id);
                    currentSaldo = saldoRes ? parseFloat(saldoRes.total_saldo || 0) : 0;
                }

                const daysElapsed = (new Date() - new Date(g.fecha_envio)) / (1000 * 60 * 60 * 24);

                if (currentSaldo === 0 && g.saldo_al_enviar > 0) {
                    updateGestion.run('exitoso_total', g.id);
                } else if (currentSaldo < g.saldo_al_enviar) {
                    updateGestion.run('exitoso_parcial', g.id);
                } else if (daysElapsed >= 30) {
                    updateGestion.run('vencido_sin_pago', g.id);
                }
            }
        })();
    } catch (e) {
        console.error('Error evaluando atribución de métricas:', e);
    }
};

db.sincronizarSaldosCuotasHistorial = () => {
    try {
        const polizas = db.prepare('SELECT id, cuotas_debe, saldo_pendiente, cuotas_historial FROM polizas').all();
        const updateStmt = db.prepare('UPDATE polizas SET cuotas_debe = ?, saldo_pendiente = ? WHERE id = ?');
        db.transaction(() => {
            for (const p of polizas) {
                if (!p.cuotas_historial) continue;
                let hist = [];
                try { hist = JSON.parse(p.cuotas_historial); } catch(e){}
                if (!Array.isArray(hist) || hist.length === 0) continue;

                const pendingCuotas = hist.filter(c => (c.estado === 'PENDIENTE' || !c.estado) && (c.saldo_cli > 0 || c.saldo > 0));
                const pendingCount = pendingCuotas.length;
                const pendingTotal = pendingCuotas.reduce((sum, c) => sum + (c.saldo_cli || c.saldo || 0), 0);

                if (p.cuotas_debe !== pendingCount || Math.abs((p.saldo_pendiente || 0) - pendingTotal) > 0.01) {
                    updateStmt.run(pendingCount, pendingTotal, p.id);
                }
            }
        })();
    } catch (e) {
        console.error('Error sincronizando saldos de cuotas_historial:', e);
    }
};

db.sincronizarEstadosCuotasMoraFechas = () => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        db.transaction(() => {
            // 1. En cuotas_admin, corregir cualquier cuota que no esté PAGADA:
            // Si fecha_vencimiento >= hoyStr => PENDIENTE
            // Si fecha_vencimiento < hoyStr => VENCIDO
            db.prepare("UPDATE cuotas_admin SET estado = 'PENDIENTE' WHERE estado != 'PAGADO' AND fecha_vencimiento >= ?").run(todayStr);
            db.prepare("UPDATE cuotas_admin SET estado = 'VENCIDO' WHERE estado != 'PAGADO' AND fecha_vencimiento < ?").run(todayStr);

            // 2. En polizas, cuotas_debe representa el conteo de cuotas VENCIDAS REALES (fecha_vencimiento < hoyStr)
            const polizas = db.prepare('SELECT id, fecha_vencimiento, cuotas_historial FROM polizas').all();
            const updatePolizaStmt = db.prepare('UPDATE polizas SET cuotas_debe = ? WHERE id = ?');

            for (const p of polizas) {
                let cuotasDebeCount = 0;
                if (p.cuotas_historial) {
                    try {
                        const list = JSON.parse(p.cuotas_historial);
                        if (Array.isArray(list)) {
                            cuotasDebeCount = list.filter(c => c.estado !== 'PAGADA' && c.vto_cuota && c.vto_cuota < todayStr).length;
                        }
                    } catch(e){}
                } else {
                    if (p.fecha_vencimiento && p.fecha_vencimiento < todayStr) {
                        cuotasDebeCount = 1;
                    }
                }
                updatePolizaStmt.run(cuotasDebeCount, p.id);
            }
        })();
        console.log('✅ Estados de cuotas y mora de clientes sincronizados según estricta comparación de fechas (fecha_vencimiento vs hoy).');
    } catch (e) {
        console.error('Error en sincronizarEstadosCuotasMoraFechas:', e);
    }
};

db.sincronizarTelefonosHistoricos = () => {
    try {
        const items = db.prepare("SELECT id, telefono FROM polizas_historicas WHERE telefono IS NOT NULL AND telefono != ''").all();
        db.transaction(() => {
            for (const item of items) {
                let phone = String(item.telefono).replace(/[^\d]/g, '');
                if (phone.startsWith('549')) phone = phone.substring(3);
                else if (phone.startsWith('54')) phone = phone.substring(2);
                while (phone.startsWith('0')) phone = phone.substring(1);
                if (phone.startsWith('22315') && phone.length >= 12) phone = '223' + phone.substring(5);
                else if (phone.startsWith('15') && phone.length === 9) phone = phone.substring(2);
                if (phone.startsWith('2230') && phone.length > 10) phone = '223' + phone.substring(3).replace(/^0+/, '');
                if (phone.length === 7 || phone.length === 8) phone = '223' + phone;

                if (phone.length === 10) {
                    const formatted = '549' + phone;
                    if (formatted !== item.telefono) {
                        db.prepare('UPDATE polizas_historicas SET telefono = ? WHERE id = ?').run(formatted, item.id);
                    }
                }
            }
        })();
        console.log('✅ Teléfonos de Cartera de Recuperación sincronizados y estandarizados con formato 549.');
    } catch (e) {
        console.error('Error en sincronizarTelefonosHistoricos:', e);
    }
};

db.inicializarCuotasAdmin = () => {
    try {
        const count = db.prepare('SELECT COUNT(*) as c FROM cuotas_admin').get().c;
        if (count > 0) return;

        const polizas = db.prepare('SELECT id, saldo_pendiente, fecha_vencimiento, cuotas_debe, cuotas_historial FROM polizas').all();
        const insertStmt = db.prepare(`
            INSERT INTO cuotas_admin (poliza_id, numero_cuota, monto_poliza, monto_acarreo, monto_total, fecha_vencimiento, estado)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
            for (const p of polizas) {
                let cuotasList = [];
                if (p.cuotas_historial) {
                    try { cuotasList = JSON.parse(p.cuotas_historial); } catch(e){}
                }

                if (Array.isArray(cuotasList) && cuotasList.length > 0) {
                    for (const c of cuotasList) {
                        let total = parseFloat(c.saldo_cli || c.saldo || 0);
                        if (total === 0 || total === 35000) total = 32000;
                        const nro = parseInt(c.nro_cuota || 1);
                        const vto = c.vto_cuota || p.fecha_vencimiento || new Date().toISOString().split('T')[0];
                        const estado = c.estado === 'PAGADA' ? 'PAGADO' : (vto < new Date().toISOString().split('T')[0] ? 'VENCIDO' : 'PENDIENTE');

                        const montoAcarreo = 1760; // Valor real servicio de remolque Grucar
                        const montoPoliza = Math.max(0, Math.round((total - montoAcarreo) * 100) / 100);

                        insertStmt.run(p.id, nro, montoPoliza, montoAcarreo, total, vto, estado);
                    }
                } else {
                    let total = parseFloat(p.saldo_pendiente || 32000);
                    if (total === 0 || total === 35000) total = 32000;
                    const vto = p.fecha_vencimiento || new Date().toISOString().split('T')[0];
                    const estado = p.cuotas_debe > 0 ? (vto < new Date().toISOString().split('T')[0] ? 'VENCIDO' : 'PENDIENTE') : 'PAGADO';

                    const montoAcarreo = 1760; // Valor real servicio de remolque Grucar
                    const montoPoliza = Math.max(0, Math.round((total - montoAcarreo) * 100) / 100);

                    insertStmt.run(p.id, 1, montoPoliza, montoAcarreo, total, vto, estado);
                }
            }
        })();
        console.log('✅ Tabla cuotas_admin inicializada con montos reales Emisión ($30.240) + Grucar ($1.760).');
    } catch (e) {
        console.error('Error inicializando cuotas_admin:', e);
    }
};

// Ejecutar al iniciar para mantener integridad
db.sincronizarSaldosCuotasHistorial();
db.inicializarCuotasAdmin();

module.exports = db;
