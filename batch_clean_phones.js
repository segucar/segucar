const db = require('./database.js');

function strictSanitizeWhatsappPhone(rawPhone) {
    if (!rawPhone) return '';
    let str = String(rawPhone).replace(/[^\d]/g, '');
    if (!str) return '';

    if (str.startsWith('549')) {
        str = str.substring(3);
    } else if (str.startsWith('54')) {
        str = str.substring(2);
    }

    while (str.startsWith('0')) {
        str = str.substring(1);
    }

    if (str.startsWith('22315') && str.length >= 11) {
        str = '223' + str.substring(5);
    } else if (str.startsWith('15') && str.length === 9) {
        str = str.substring(2);
    }

    if (str.startsWith('2230') && str.length === 11) {
        str = '223' + str.substring(4);
    }

    if (str.length === 7 || str.length === 8) {
        str = '223' + str;
    }

    if (str.length === 10) {
        return '549' + str;
    }

    return '';
}

console.log('=== EJECUTANDO LIMPIEZA BATCH SOBRE BASE DE DATOS ===');
const clients = db.prepare("SELECT id, nombre, telefono FROM clientes WHERE telefono IS NOT NULL AND telefono != ''").all();
let updatedCount = 0;
let clearedCount = 0;

const updateCli = db.prepare("UPDATE clientes SET telefono = ? WHERE id = ?");

db.transaction(() => {
    for (const c of clients) {
        const sanitized = strictSanitizeWhatsappPhone(c.telefono);
        if (sanitized !== c.telefono) {
            updateCli.run(sanitized, c.id);
            if (sanitized && typeof db.guardarTelefonoMaestro === 'function') {
                db.guardarTelefonoMaestro(c.id, c.nombre, sanitized, 'batch_clean');
            }
            if (sanitized) updatedCount++;
            else clearedCount++;
            console.log(`[Batch Clean] ${c.nombre}: "${c.telefono}" -> "${sanitized || '(vacío)'}"`);
        }
    }
})();

console.log(`✅ Batch clean finalizado. Modificados: ${updatedCount} | Incompletos limpiados a vacíos: ${clearedCount}`);
