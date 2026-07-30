require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let dbPath = path.join(dataDir, 'gestionseguro.db');

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

// ─── Seed plantillas por defecto ────────────────────────────────────────────

// Purge any old combined templates to guarantee clean single-variable templates
db.prepare("DELETE FROM plantillas WHERE tipo LIKE 'combinado%' OR nombre LIKE '%Combinado%'").run();

let appName = 'SEGUCar';
try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.appName) appName = config.appName;
    }
} catch (e) {}

const countPlantillas = db.prepare('SELECT COUNT(*) as count FROM plantillas').get().count;
if (countPlantillas === 0) {
    const insertPlantilla = db.prepare('INSERT INTO plantillas (nombre, tipo, mensaje) VALUES (?, ?, ?)');

    // 1. 🟡 PREVENTIVO (0-48hs previo a vencer)
    insertPlantilla.run(
        '🟡 Cuota: Recordatorio Preventivo (Vence en 48 hs)',
        'recordatorio_48hs',
        'Hola {nombre}, ¿cómo estás? Te aviso que en 48 hs vence la cuota de tu seguro ({vehiculo} - Patente {patente}). Escribinos si querés abonarla o si necesitás el cbu/link de pago. ¡Saludos!'
    );

    // 2. 🟠 PRIMER AVISO (Vencida hace 48 hs)
    insertPlantilla.run(
        '🟠 Cuota: Primer Aviso (Vencida hace 48 hs)',
        'primer_aviso',
        'Hola {nombre}, te recuerdo que la cuota de tu seguro ({vehiculo} - Patente {patente}) venció hace 48 hs. Avisame si necesitás los datos de pago así te mantenemos la cobertura al día. ¡Gracias!'
    );

    // 3. 🔴 SEGUNDO AVISO (Vencida hace 96 hs)
    insertPlantilla.run(
        '🔴 Cuota: Segundo Aviso (Vencida hace 96 hs)',
        'segundo_aviso',
        'Hola {nombre}, te informamos que la cuota de tu seguro ({vehiculo} - Patente {patente}) venció hace 96 hs y finaliza tu período de gracia. Escribinos para regularizar la cuota antes de perder la cobertura.'
    );

    // 4. 🚨 MORA CRÍTICA (+96hs / Perdió Período de Gracia)
    insertPlantilla.run(
        '🚨 Cuota: Mora Crítica (+96 hs / Perdió Período de Gracia)',
        'mora_critica',
        'Hola {nombre}, te aviso que la cuota de tu seguro ({vehiculo} - Patente {patente}) venció hace más de 4 días (o registrás cuotas impagas). La póliza perdió la cobertura. Escribinos urgente para regularizar tu situación.'
    );

    // 5. 📄 AVISO RENOVACIÓN 7 DÍAS
    insertPlantilla.run(
        '📄 Póliza: Aviso Renovación (Vence en 7 Días)',
        'renovacion_7_dias',
        'Hola {nombre}, ¿cómo estás? Te informamos que en 7 días vence la póliza de tu {vehiculo} (Patente {patente}). Avisame si querés renovarla así te preparamos la nueva cobertura con anticipación. ¡Un saludo!'
    );

    // 6. ⚫ PÓLIZA VENCIDA
    insertPlantilla.run(
        '⚫ Póliza: Aviso Póliza Vencida',
        'poliza_vencida',
        `Hola {nombre}, te escribimos de ${appName} para avisarte que la póliza de tu {vehiculo} (Patente {patente}) venció el {fecha_vencimiento}. ¿Querés que la renovemos así seguís circulando con tranquilidad y cobertura? Quedamos a tu disposición. ¡Un saludo!`
    );

    // 7. 🔄 RECTIVACIÓN CARTERA HISTÓRICA
    insertPlantilla.run(
        '🔄 Recuperación: Propuesta Reactivación Cartera Histórica',
        'recuperacion_historica',
        `Hola {nombre}, te saludamos de ${appName}. Queremos ponernos en contacto nuevamente por tu {vehiculo} (Dominio: {patente}). Contamos con nuevas propuestas y excelentes coberturas para reactivar tu póliza. ¡Consultanos sin compromiso!`
    );

    console.log('✅ Plantillas exclusivas por variable creadas.');
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

module.exports = db;
