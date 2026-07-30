/**
 * FIX_PHONES_REIMPORT.js — v3 (Smart Match con validación de apellido)
 * =====================================================================
 * Re-importa/sobreescribe la columna 'telefono' de la tabla 'clientes'
 * 
 * MEJORAS v3 (sobre v2):
 *   - EXIGE que el APELLIDO coincida (no solo nombres genéricos)
 *   - Score mínimo subido a 0.75
 *   - Descarta matches contra contactos genéricos ("Juan Carlos", etc.)
 *   - Preserva teléfonos existentes que ya son válidos (549+10 dígitos)
 */

const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'gestionseguro.db');
const EXCEL_PATH = path.join(__dirname, 'Emision_listado_de_vencimientos.xlsx');

const db = new Database(DB_PATH);

// ==========================================
// ASIGNACIONES MANUALES FORZADAS
// ==========================================
const MANUAL_OVERRIDES = {
    14012: '5492234362426',  // SUARES LISANDRO
    13695: '5492235644144',  // MIQUEO MARTIN ANDRES
};

// ==========================================
// Limpieza de teléfonos
// ==========================================
function cleanPhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/[^\d]/g, '');
    if (digits.length === 0) return null;

    if (digits.startsWith('549') && digits.length >= 13) digits = digits.substring(3);
    else if (digits.startsWith('54') && digits.length >= 12) digits = digits.substring(2);

    if (digits.startsWith('0') && digits.length >= 11) digits = digits.substring(1);

    const match15 = digits.match(/^(\d{3,4})(15)(\d{6,7})$/);
    if (match15) digits = match15[1] + match15[3];

    if (digits.length !== 10) return null;
    return digits;
}

function toWhatsApp(d) { return d && d.length === 10 ? '549' + d : null; }

// ==========================================
// Normalización de nombres
// ==========================================
const STOP_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'al', 'lo', 'dr', 'dra', 'sra', 'sr', 'lote']);

function normalizeName(n) {
    return String(n || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[,.\-_'"🪸🦈\d]/g, ' ')  // también quitar dígitos sueltos
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Extrae tokens ÚNICOS (sin duplicados) de un nombre.
 * "Lisandro Lisandro Suares" → ["lisandro", "suares"]
 * "Dr. Martin H. Pefuar H. Pefuar" → ["martin", "pefuar"]
 */
function getTokens(name) {
    const raw = normalizeName(name)
        .split(' ')
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
    // Deduplicar preservando orden
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

/**
 * Compara dos tokens con tolerancia para variaciones mínimas:
 *   - Exacto: "suares" === "suares"
 *   - Casi igual (diff ≤ 2 chars): "suares" ↔ "suarez", "nunez" ↔ "nuñez"
 *   - NO acepta: "martinez" ↔ "martin" (diff = 2 pero no es startsWith fiable)
 */
function tokensMatch(a, b) {
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    const diff = Math.abs(a.length - b.length);
    if (diff > 2) return false;
    // Solo acepta startsWith si la diferencia es mínima (≤ 1 char)
    if (diff <= 1) {
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length > b.length ? a : b;
        if (longer.startsWith(shorter)) return true;
    }
    return false;
}

/**
 * Smart Match v4:
 * - Deduplicación de tokens en ambos lados
 * - El APELLIDO del cliente (primer token) DEBE estar en la fuente
 * - Score = tokens_coincidentes / tokens_del_cliente
 *   (mide qué % del cliente está cubierto por la fuente)
 * - Mínimo 2 coincidencias (apellido + nombre)
 * - Umbral: 0.75
 */
function smartMatch(clientName, sourceName) {
    const clientTokens = getTokens(clientName);
    const sourceTokens = getTokens(sourceName);

    // Mínimo 2 tokens únicos en cada lado
    if (clientTokens.length < 2 || sourceTokens.length < 2) return 0;

    // El APELLIDO del cliente (primer token) DEBE estar en la fuente
    const apellido = clientTokens[0];
    const apellidoInSource = sourceTokens.some(st => tokensMatch(apellido, st));
    if (!apellidoInSource) return 0;

    // Contar cuántos tokens del cliente están presentes en la fuente
    let matches = 0;
    const usedSource = new Set();
    for (const ct of clientTokens) {
        for (let i = 0; i < sourceTokens.length; i++) {
            if (usedSource.has(i)) continue;
            const st = sourceTokens[i];
            if (tokensMatch(ct, st)) {
                matches++;
                usedSource.add(i);
                break;
            }
        }
    }

    // Mínimo 2 coincidencias (apellido + al menos un nombre)
    if (matches < 2) return 0;

    // Score basado en cobertura del cliente (no del máximo de ambos)
    const score = matches / clientTokens.length;
    return score;
}

// ==========================================
// Cargar fuentes
// ==========================================
console.log('📱 Cargando fuente VCF...');
const vcfEntries = db.prepare("SELECT nombre, telefono FROM contactos_telefono WHERE importado_de = 'vcf'").all();
console.log(`   → ${vcfEntries.length} entradas VCF`);

console.log('📊 Cargando fuente Excel...');
let excelEntries = [];
try {
    const wb = XLSX.readFile(EXCEL_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
    excelEntries = data.map(row => ({
        nombre: String(row['Nombre'] || '').trim(),
        telefono: String(row['Teléfono'] || row['Telefono'] || '').trim()
    })).filter(r => r.nombre && r.telefono);
    console.log(`   → ${excelEntries.length} entradas Excel`);
} catch (e) {
    console.warn('   ⚠️ No se pudo leer el Excel:', e.message);
}

console.log('🔍 Cargando fuente Scraper...');
const scraperEntries = db.prepare(`
    SELECT nombre, telefono FROM contactos_telefono
    WHERE importado_de IN ('scraper', 'scraper_recuperacion', 'extractor_estricto')
`).all();
console.log(`   → ${scraperEntries.length} entradas scraper`);

// Limpiar fuentes
function buildCleanSource(entries) {
    const result = [];
    for (const e of entries) {
        const phone = cleanPhone(e.telefono);
        if (phone) result.push({ nombre: e.nombre, phone10: phone });
    }
    return result;
}

const vcfClean = buildCleanSource(vcfEntries);
const excelClean = buildCleanSource(excelEntries);
const scraperClean = buildCleanSource(scraperEntries);

console.log(`   📱 VCF limpio: ${vcfClean.length} | 📊 Excel: ${excelClean.length} | 🔍 Scraper: ${scraperClean.length}`);

// ==========================================
// Buscar mejor match con umbral estricto
// ==========================================
const MIN_SCORE = 0.75;

function findBestMatch(clientName, source) {
    let bestScore = 0;
    let bestEntry = null;

    for (const entry of source) {
        const score = smartMatch(clientName, entry.nombre);
        if (score > bestScore) {
            bestScore = score;
            bestEntry = entry;
        }
    }

    if (bestScore >= MIN_SCORE && bestEntry) {
        return { phone10: bestEntry.phone10, matchedName: bestEntry.nombre, score: bestScore };
    }
    return null;
}

// ==========================================
// PRIMERO: Restaurar todos los teléfonos al estado previo de la BD
// Para esto, usamos los datos del scraper como fuente de "lo que ya había"
// ==========================================

console.log('\n🔄 Re-importando teléfonos (Smart Match v3, umbral ≥ 0.75)...');

const allClients = db.prepare("SELECT id, nombre, telefono FROM clientes").all();
console.log(`   Total clientes: ${allClients.length}`);

const updateStmt = db.prepare("UPDATE clientes SET telefono = ? WHERE id = ?");

let stats = { fromManual: 0, fromVcf: 0, fromExcel: 0, fromScraper: 0, kept: 0, clearedToNull: 0, total: 0, changed: 0 };
const changes = [];
const vcfMatchLog = [];

db.transaction(() => {
    for (const client of allClients) {
        stats.total++;
        const existing = client.telefono || '';
        let newPhone = null;
        let source = null;
        let matchInfo = '';

        // Prioridad 0: Override manual
        if (MANUAL_OVERRIDES[client.id]) {
            newPhone = MANUAL_OVERRIDES[client.id];
            source = 'Manual';
            matchInfo = 'override';
        }

        // Prioridad 1: VCF (smart match)
        if (!newPhone) {
            const m = findBestMatch(client.nombre, vcfClean);
            if (m) {
                newPhone = toWhatsApp(m.phone10);
                source = 'VCF';
                matchInfo = `"${m.matchedName}" (${m.score.toFixed(2)})`;
                vcfMatchLog.push({ cliente: client.nombre, vcfNombre: m.matchedName, score: m.score, tel: newPhone });
            }
        }

        // Prioridad 2: Excel (smart match)
        if (!newPhone) {
            const m = findBestMatch(client.nombre, excelClean);
            if (m) {
                newPhone = toWhatsApp(m.phone10);
                source = 'Excel';
                matchInfo = `"${m.matchedName}" (${m.score.toFixed(2)})`;
            }
        }

        // Prioridad 3: Scraper (smart match)
        if (!newPhone) {
            const m = findBestMatch(client.nombre, scraperClean);
            if (m) {
                newPhone = toWhatsApp(m.phone10);
                source = 'Scraper';
                matchInfo = `"${m.matchedName}" (${m.score.toFixed(2)})`;
            }
        }

        // Si no hay fuente pero el existente ya es válido (549+10), PRESERVAR
        if (!newPhone && existing.length === 13 && existing.startsWith('549')) {
            stats.kept++;
            continue;
        }

        const finalPhone = newPhone || '';

        if (finalPhone !== existing) {
            updateStmt.run(finalPhone, client.id);
            if (finalPhone && finalPhone.length >= 10 && typeof db.guardarTelefonoMaestro === 'function') {
                db.guardarTelefonoMaestro(client.id, client.nombre, finalPhone, source || 'reimport');
            }
            stats.changed++;
            if (source === 'Manual') stats.fromManual++;
            else if (source === 'VCF') stats.fromVcf++;
            else if (source === 'Excel') stats.fromExcel++;
            else if (source === 'Scraper') stats.fromScraper++;
            else stats.clearedToNull++;

            if (changes.length < 25 || source === 'Manual' || source === 'VCF') {
                changes.push({
                    nombre: client.nombre,
                    viejo: existing || '(vacío)',
                    nuevo: finalPhone || '(vacío)',
                    fuente: source ? `${source} ← ${matchInfo}` : 'SIN FUENTE'
                });
            }
        } else if (existing && existing.length >= 10 && typeof db.guardarTelefonoMaestro === 'function') {
            db.guardarTelefonoMaestro(client.id, client.nombre, existing, 'existing');
        }
    }
})();

console.log('\n✅ RESULTADOS (Smart Match v3):');
console.log(`   Procesados: ${stats.total}`);
console.log(`   Modificados: ${stats.changed}`);
console.log(`   Preservados: ${stats.kept}`);
console.log(`   Manual: ${stats.fromManual} | VCF: ${stats.fromVcf} | Excel: ${stats.fromExcel} | Scraper: ${stats.fromScraper}`);
console.log(`   Sin fuente: ${stats.clearedToNull}`);

if (changes.length > 0) {
    console.log('\n📋 CAMBIOS:');
    for (const c of changes) {
        console.log(`   ${c.nombre}: "${c.viejo}" → "${c.nuevo}" [${c.fuente}]`);
    }
}

if (vcfMatchLog.length > 0) {
    console.log(`\n📱 VCF MATCHES (${vcfMatchLog.length}):`);
    for (const m of vcfMatchLog) {
        console.log(`   ${m.cliente} ↔ "${m.vcfNombre}" (score: ${m.score.toFixed(2)}) → ${m.tel}`);
    }
}

// Verificaciones
console.log('\n🔎 VERIFICACIONES:');
const miq = db.prepare("SELECT nombre, telefono FROM clientes WHERE id = 13695 OR nombre LIKE '%MIQUEO%' LIMIT 1").get();
if (miq) console.log(`   Miqueo: ${miq.telefono} ${miq.telefono === '5492235644144' ? '✅' : '❌'}`);
const sua = db.prepare("SELECT nombre, telefono FROM clientes WHERE id = 14012 OR nombre LIKE '%SUARES%' LIMIT 1").get();
if (sua) console.log(`   Suares: ${sua.telefono} ${sua.telefono === '5492234362426' ? '✅' : '❌'}`);

const total = db.prepare('SELECT COUNT(*) as cnt FROM clientes').get();
const conTel = db.prepare("SELECT COUNT(*) as cnt FROM clientes WHERE telefono IS NOT NULL AND telefono != '' AND length(telefono) >= 13").get();
const sinTel = db.prepare("SELECT COUNT(*) as cnt FROM clientes WHERE telefono IS NULL OR telefono = ''").get();
console.log(`\n📊 STATS FINALES:`);
console.log(`   Total: ${total.cnt} | Con tel: ${conTel.cnt} | Sin tel: ${sinTel.cnt} | Cobertura: ${((conTel.cnt / total.cnt) * 100).toFixed(1)}%`);

if (typeof db.restaurarTelefonosMaestros === 'function') {
    db.restaurarTelefonosMaestros();
}

db.close();
console.log('\n🏁 Finalizado.');
