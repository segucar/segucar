/**
 * export-template.js — Script de Exportación del Paquete Template Whitelabel
 * 
 * 1. Ejecuta init-db.js para dejar la BD totalmente limpia.
 * 2. Limpia archivos de log o pruebas temporales.
 * 3. Empaqueta el proyecto en 'SEGUCar_System_Template.zip'.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🚀 Iniciando proceso de empaquetado Whitelabel Template...');

// 1. Inicializar BD limpia
console.log('\n[1/3] Inicializando base de datos vacía...');
execSync('node init-db.js', { stdio: 'inherit' });

// 2. Limpiar logs y archivos de prueba temporales
console.log('\n[2/3] Limpiando archivos temporales y logs de prueba...');
const filesToRemove = [
    'server.log',
    'watcher.log',
    'scraper_background.log',
    'Emision_listado_de_vencimientos.xlsx',
    'SEGUCar_System_Template.zip'
];

filesToRemove.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`  - Eliminado: ${file}`);
        } catch (e) {
            console.warn(`  - Advertencia al eliminar ${file}:`, e.message);
        }
    }
});

// 3. Crear ZIP limpio
console.log('\n[3/3] Generando paquete SEGUCar_System_Template.zip...');
const zipCmd = `zip -r SEGUCar_System_Template.zip . -x "node_modules/*" "*.log" "scratch_*" "test_*" "debug_*" "inspect_*" "fix_phones_reimport.js" ".git/*" ".DS_Store" "*.xlsx" "*.vcf" "export-template.js"`;

try {
    execSync(zipCmd, { cwd: __dirname, stdio: 'inherit' });
    const zipPath = path.join(__dirname, 'SEGUCar_System_Template.zip');
    if (fs.existsSync(zipPath)) {
        const stats = fs.statSync(zipPath);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        console.log('\n======================================================');
        console.log('🎉 PAQUETE TEMPLATE WHITELABEL GENERADO EXITOSAMENTE');
        console.log('======================================================');
        console.log(`📦 Archivo:  SEGUCar_System_Template.zip`);
        console.log(`📏 Tamaño:   ${sizeMb} MB`);
        console.log(`📍 Ubicación: ${zipPath}`);
        console.log('======================================================\n');
    } else {
        console.error('❌ Error: No se creó el archivo ZIP.');
    }
} catch (err) {
    console.error('❌ Error al ejecutar comando zip:', err.message);
}
