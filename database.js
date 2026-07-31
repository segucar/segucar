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
`);

// ─── Migraciones de Columnas para Auditar NRE ────────────────────────────────
const addColumn = (colName, colDef) => {
    try {
        db.exec(`ALTER TABLE polizas ADD COLUMN ${colName} ${colDef}`);
    } catch (e) {
        // Ignorar si la columna ya existe
    }
};
addColumn('nro_cuota', 'INTEGER DEFAULT 1');
addColumn('total_cuotas', 'INTEGER DEFAULT 3');
addColumn('saldo_pendiente', 'REAL DEFAULT 0');
addColumn('fin_vigencia_poliza', 'DATE');
addColumn('cuotas_historial', 'TEXT');
addColumn('fecha_vencimiento_grucar', 'DATE');
addColumn('grucar_activo', 'INTEGER DEFAULT 1');

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

module.exports = db;
