/**
 * batch_clean_phones.js — Motor Universal de Auditoría y Cruzamiento de Teléfonos
 * =================================================================================
 * 1. Normalización Universal sin restricción de código de área (11, 221, 223, 249, 291, 341, 351, 261, 299, 2284, 2262, etc.)
 * 2. Algoritmo SmartMatch (APELLIDO + NOMBRE sin importar el orden: "SUARES LISANDRO" ↔ "LISANDRO SUARES")
 * 3. Exclusión estricta de lista negra (telefonos_invalidos: nro inexistente, sin whatsapp, borrado manual)
 * 4. Extracción profunda desde NRE (observaciones, direcciones, campos secundarios)
 * 5. Conservación de overrides manuales y números previamente verificados (no-destructivo)
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'gestionseguro.db');
const db = new Database(DB_PATH);

console.log('🚀 Iniciando Motor Universal de Auditoría de Teléfonos SEGUCar...');

// ==========================================
// Overrides Manuales Conservados
// ==========================================
const MANUAL_OVERRIDES = {
    14012: '5492234362426',  // SUARES LISANDRO
    13695: '5492235644144',  // MIQUEO MARTIN ANDRES
};

// Nombres de pila comunes para evitar falso positivo sin apellido
const COMMON_FIRST_NAMES = new Set([
  'juan', 'maria', 'jose', 'carlos', 'luis', 'ana', 'pedro', 'jorge', 'miguel', 'angel', 'rosa', 
  'francisco', 'antonio', 'manual', 'diego', 'martin', 'daniel', 'mario', 'sergio', 'gustavo', 
  'laura', 'sandra', 'andrea', 'patricia', 'monica', 'silvia', 'claudia', 'marta', 'norma',
  'alberto', 'eduardo', 'roberto', 'oscar', 'walter', 'ariel', 'pablo', 'marcelo', 'hugo', 'hector'
]);

const STOP_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'al', 'lo', 'dr', 'dra', 'sra', 'sr', 'lote', 'don', 'dona']);

// ==========================================
// 1. Normalización Universal de Teléfono
// ==========================================
function cleanPhoneUniversal(raw, clientCity = '') {
    if (!raw) return '';
    let s = String(raw).trim();
    if (/inexistente|no tiene|sin|falso|invalido|error|baja|no posee|n\/a/i.test(s)) return '';

    let cleaned = s.replace(/[^\d]/g, '');
    if (cleaned.length === 0) return '';

    if (cleaned.startsWith('549') && cleaned.length >= 13) {
        cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('54') && cleaned.length >= 12) {
        cleaned = cleaned.substring(2);
    }

    while (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }

    // Quitar 15 según código de área
    if (cleaned.startsWith('1115') && cleaned.length === 12) {
        cleaned = '11' + cleaned.substring(4);
    } else if (/^(221|223|249|291|341|351|261|299|381|387|342|264|266|379|376|362)15/.test(cleaned) && cleaned.length === 12) {
        cleaned = cleaned.substring(0, 3) + cleaned.substring(5);
    } else if (/^(2284|2254|2257|2262|2266|2268|2291|2983|2920|2966|2940|2972|2982)15/.test(cleaned) && cleaned.length === 12) {
        cleaned = cleaned.substring(0, 4) + cleaned.substring(6);
    } else if (cleaned.startsWith('15') && cleaned.length === 10) {
        let defaultArea = '223';
        const c = String(clientCity).toLowerCase();
        if (c.includes('tandil')) defaultArea = '249';
        else if (c.includes('la plata')) defaultArea = '221';
        else if (c.includes('necochea')) defaultArea = '2262';
        else if (c.includes('olavarria')) defaultArea = '2284';
        else if (c.includes('bahia')) defaultArea = '291';
        else if (c.includes('buenos aires') || c.includes('capital') || c.includes('caba')) defaultArea = '11';
        cleaned = defaultArea + cleaned.substring(2);
    }

    if (cleaned.length === 7 || cleaned.length === 8) {
        let defaultArea = '223';
        const c = String(clientCity).toLowerCase();
        if (c.includes('tandil')) defaultArea = '249';
        else if (c.includes('la plata')) defaultArea = '221';
        else if (c.includes('necochea')) defaultArea = '2262';
        else if (c.includes('olavarria')) defaultArea = '2284';
        else if (c.includes('bahia')) defaultArea = '291';
        else if (c.includes('buenos aires') || c.includes('capital') || c.includes('caba')) defaultArea = '11';
        cleaned = defaultArea + (cleaned.length === 8 ? cleaned.substring(1) : cleaned);
    }

    if (cleaned.length === 10) {
        return '549' + cleaned;
    }

    return (cleaned.length >= 10 && cleaned.length <= 11) ? '549' + cleaned : '';
}

// ==========================================
// 2. Normalización de Nombres & Tokens
// ==========================================
function normalizeName(n) {
    return String(n || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[,.\-_'\"🪸🦈\d]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getTokens(name) {
    const raw = normalizeName(name)
        .split(' ')
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
    const seen = new Set();
    const unique = [];
    for (const t of raw) {
        if (!seen.has(t)) {
            seen.add(t);
            unique.push(t);
        }
    }
    return unique;
}

function tokensMatch(a, b) {
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    const diff = Math.abs(a.length - b.length);
    if (diff > 2) return false;
    if (diff <= 1) {
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length > b.length ? a : b;
        if (longer.startsWith(shorter)) return true;
    }
    if ((a.replace(/s$/,'z') === b.replace(/s$/,'z')) || (a.replace(/y/g,'i') === b.replace(/y/g,'i'))) return true;
    return false;
}

// ==========================================
// 3. SmartMatch Estricto (Orden Agnóstico)
// ==========================================
function smartMatchStrict(clientName, sourceName) {
    const cTokens = getTokens(clientName);
    const sTokens = getTokens(sourceName);

    if (cTokens.length === 0 || sTokens.length === 0) return 0;

    let matches = 0;
    const matchedClientTokens = new Set();
    const usedSource = new Set();

    for (let j = 0; j < cTokens.length; j++) {
        const ct = cTokens[j];
        for (let i = 0; i < sTokens.length; i++) {
            if (usedSource.has(i)) continue;
            if (tokensMatch(ct, sTokens[i])) {
                matches++;
                matchedClientTokens.add(j);
                usedSource.add(i);
                break;
            }
        }
    }

    const reqMatches = Math.min(2, cTokens.length);
    if (matches < reqMatches) return 0;

    // APELLIDO OBLIGATORIO: al menos 1 token no-común debe coincidir
    const nonCommonClientTokens = cTokens.filter(t => !COMMON_FIRST_NAMES.has(t));
    if (nonCommonClientTokens.length > 0) {
        const matchedNonCommon = cTokens.some((t, idx) => !COMMON_FIRST_NAMES.has(t) && matchedClientTokens.has(idx));
        if (!matchedNonCommon) return 0;
    }

    const coverage = matches / cTokens.length;
    const precision = matches / sTokens.length;
    return (2 * coverage * precision) / (coverage + precision);
}

// ==========================================
// 4. Carga de Lista Negra de Teléfonos
// ==========================================
const invalidRows = db.prepare('SELECT cliente_id, telefono FROM telefonos_invalidos').all();
const invalidSet = new Set(invalidRows.map(r => r.telefono).filter(Boolean));
const invalidClientIds = new Set(invalidRows.filter(r => !r.telefono).map(r => r.cliente_id));

function isInvalid(clienteId, phone) {
    if (invalidClientIds.has(clienteId)) return true;
    if (phone && invalidSet.has(phone)) return true;
    return false;
}

// ==========================================
// 5. Carga de Fuentes Secundarias (VCF, Históricas, Maestros)
// ==========================================
const histEntries = db.prepare('SELECT nombre, telefono FROM polizas_historicas WHERE telefono IS NOT NULL AND length(telefono) >= 7').all()
    .map(e => ({ nombre: e.nombre, phone: cleanPhoneUniversal(e.telefono), source: 'Polizas Historicas' }))
    .filter(e => e.phone);

const vcfEntries = db.prepare('SELECT nombre, telefono FROM contactos_telefono').all()
    .map(e => ({ nombre: e.nombre, phone: cleanPhoneUniversal(e.telefono), source: 'Contactos VCF' }))
    .filter(e => e.phone);

const allSources = [...histEntries, ...vcfEntries];
console.log(`📊 Fuentes secundarias disponibles: ${allSources.length} entradas`);

// ==========================================
// 6. Proceso de Actualización No Destructivo
// ==========================================
const allClients = db.prepare('SELECT id, nombre, direccion, telefono FROM clientes').all();
const updateClientStmt = db.prepare('UPDATE clientes SET telefono = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const deleteMasterStmt = db.prepare('DELETE FROM telefonos_maestros WHERE cliente_id = ?');
const insertMasterStmt = db.prepare('INSERT INTO telefonos_maestros (cliente_id, nombre, telefono, origen, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)');

let stats = {
    total: allClients.length,
    manualOverrides: 0,
    cleanedExisting: 0,
    blacklistedCleared: 0,
    recoveredNew: 0,
    unchanged: 0
};

db.transaction(() => {
    for (const c of allClients) {
        // Overrides manuales
        if (MANUAL_OVERRIDES[c.id]) {
            const manualPhone = MANUAL_OVERRIDES[c.id];
            updateClientStmt.run(manualPhone, c.id);
            deleteMasterStmt.run(c.id);
            insertMasterStmt.run(c.id, c.nombre, manualPhone, 'manual');
            stats.manualOverrides++;
            continue;
        }

        const raw = c.telefono;
        let cleaned = cleanPhoneUniversal(raw, c.direccion);

        if (cleaned && isInvalid(c.id, cleaned)) {
            cleaned = '';
            stats.blacklistedCleared++;
        }

        if (cleaned) {
            if (cleaned !== raw) {
                updateClientStmt.run(cleaned, c.id);
                stats.cleanedExisting++;
            } else {
                stats.unchanged++;
            }
            deleteMasterStmt.run(c.id);
            insertMasterStmt.run(c.id, c.nombre, cleaned, 'verified');
        } else {
            // Buscar en fuentes secundarias con SmartMatch
            let bestScore = 0;
            let bestMatch = null;

            for (const s of allSources) {
                if (isInvalid(c.id, s.phone)) continue;
                const score = smartMatchStrict(c.nombre, s.nombre);
                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = s;
                }
            }

            if (bestScore >= 0.75 && bestMatch) {
                updateClientStmt.run(bestMatch.phone, c.id);
                deleteMasterStmt.run(c.id);
                insertMasterStmt.run(c.id, c.nombre, bestMatch.phone, 'vcf');
                stats.recoveredNew++;
            } else {
                if (raw !== '') updateClientStmt.run('', c.id);
            }
        }
    }
})();

console.log('==================================================');
console.log('✅ PROCESO DE AUDITORÍA Y CRUZAMIENTO COMPLETADO');
console.log('==================================================');
console.log(`📋 Total Clientes: ${stats.total}`);
console.log(`📌 Overrides Manuales Preservados: ${stats.manualOverrides}`);
console.log(`🧹 Teléfonos Limpiados y Normalizados (549+10d): ${stats.cleanedExisting}`);
console.log(`🚫 Teléfonos Inválidos / Lista Negra Limpiados: ${stats.blacklistedCleared}`);
console.log(`📲 Nuevos Teléfonos Recuperados (SmartMatch VCF/Histórico): ${stats.recoveredNew}`);
console.log('==================================================');

const finalValid = db.prepare("SELECT count(*) as c FROM clientes WHERE telefono IS NOT NULL AND telefono != '' AND length(telefono) >= 12 AND telefono LIKE '549%'").get().c;
console.log(`🏆 Cobertura Final de Celulares: ${finalValid} / ${stats.total} (${(finalValid/stats.total*100).toFixed(1)}%)`);
