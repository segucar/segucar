/**
 * init-db.js — Script de Inicialización de Base de Datos SQLite Limpia
 * 
 * Crea/Resetea la base de datos 'gestionseguro.db' con el esquema vacio
 * de clientes, polizas e historial, manteniendo las plantillas base de WhatsApp.
 */
const path = require('path');
const fs = require('fs');

console.log('🔄 Inicializando base de datos SQLite limpia...');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'gestionseguro.db');
const walPath = path.join(dataDir, 'gestionseguro.db-wal');
const shmPath = path.join(dataDir, 'gestionseguro.db-shm');

// Crear backup automático y vaciar solo tablas operativas preservando contactos_telefono y telefonos_maestros
try {
    if (fs.existsSync(dbPath)) {
        const backupDir = path.join(dataDir, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `gestionseguro_backup_${timestamp}.db`);
        fs.copyFileSync(dbPath, backupPath);
        console.log(`📦 Backup de seguridad creado en: ${backupPath}`);

        const dbTemp = require('./database');
        dbTemp.exec(`
            DELETE FROM clientes;
            DELETE FROM polizas;
            DELETE FROM polizas_historicas;
            DELETE FROM contactos;
            DELETE FROM historial_gestiones_whatsapp;
        `);
        console.log('🧹 Tablas operativas limpiadas. Tablas maestras "contactos_telefono" y "telefonos_maestros" PRESERVADAS.');
    }
} catch (e) {
    console.warn('⚠️  No se pudo procesar la limpieza preservada:', e.message);
}

// Cargar módulo database.js para ejecutar creación de tablas y plantillas base
const db = require('./database');

// Verificar estado final
const totalClientes = db.prepare('SELECT COUNT(*) as count FROM clientes').get().count;
const totalPolizas = db.prepare('SELECT COUNT(*) as count FROM polizas').get().count;
const totalPlantillas = db.prepare('SELECT COUNT(*) as count FROM plantillas').get().count;

console.log('\n======================================================');
console.log('✅ BASE DE DATOS INICIALIZADA CON ÉXITO');
console.log('======================================================');
console.log(`- Clientes:    ${totalClientes} registros`);
console.log(`- Pólizas:     ${totalPolizas} registros`);
console.log(`- Plantillas:  ${totalPlantillas} plantillas base activas`);
console.log('------------------------------------------------------');
console.log('🚀 El sistema está listo para recibir nuevas importaciones Excel/VCF.');
console.log('======================================================\n');
