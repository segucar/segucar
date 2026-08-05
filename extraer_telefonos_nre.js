#!/usr/bin/env node
/**
 * extraer_telefonos_nre.js
 * ─────────────────────────────────────────────────────────────────
 * Busca en el portal NRE teléfonos de los clientes que NO los tienen
 * en la BD local. Chequea:
 *   - Campo "Teléfono:" de la póliza
 *   - Campo "Dirección:" (los nros de teléfono suelen estar inline)
 *   - Campo "Observaciones:"
 * Para cada cliente sin tel, consulta su póliza MÁS RECIENTE
 * y la MÁS ANTIGUA (en ese orden de prioridad).
 *
 * NO borra ni modifica ningún dato salvo actualizar c.telefono
 * donde estaba vacío/inválido.
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const cheerio = require('cheerio');
const db = require('./database');

const BASE_URL = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
const USUARIO  = process.env.SISTEMA_USUARIO;
const PASSWORD = process.env.SISTEMA_PASSWORD;
const DELAY_MS = 800; // pausa entre requests

// ── Phone sanitizer (same logic as server/database) ───────────────
function sanitizeAndFixPhone(raw) {
    if (!raw) return null;
    let digits = raw.replace(/\D/g, '');
    // Remove leading 0 from area codes
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    // If starts with 54 and is >= 13 digits, strip leading 54 then re-process
    if (digits.startsWith('54') && digits.length >= 13) digits = digits.slice(2);
    // Remove leading 9 (international mobile prefix 549...)
    if (digits.startsWith('9') && digits.length === 11) digits = digits.slice(1);
    // Normalize: add 549 prefix if 10-digit local number
    if (digits.length === 10) digits = '549' + digits;
    // Already has 549 prefix (13 digits)
    if (digits.length === 13 && digits.startsWith('549')) return digits;
    return null; // invalid
}

// ── Extract phone from text using sliding-window digit grouping ────
function extractPhone(text) {
    if (!text) return null;

    // Strategy: find all digit groups in the text, then try combining
    // consecutive groups to assemble a valid 10-digit Argentine phone number.
    // This handles addresses like "Calle 123 2235 597 300" or "2234-526-900".

    const digitGroups = [];
    const rx = /\d+/g;
    let m;
    while ((m = rx.exec(text)) !== null) {
        digitGroups.push({ val: m[0], idx: m.index });
    }

    // Try each group and combinations of consecutive groups as a seed
    const KNOWN_PREFIXES = ['223', '221', '2235', '2236', '2234', '2267', '2266', '2265',
                            '2254', '2255', '2251', '2252', '2257', '2261', '2262',
                            '2281', '2282', '2291', '2292', '2293', '2294', '2296', '2297',
                            '351', '341', '11'];

    for (let i = 0; i < digitGroups.length; i++) {
        // Build candidates by combining groups i, i+1, i+2
        for (let j = i; j <= Math.min(i + 3, digitGroups.length - 1); j++) {
            const combined = digitGroups.slice(i, j + 1).map(g => g.val).join('');

            // Skip numbers that are too short or too long
            if (combined.length < 9 || combined.length > 15) continue;

            // Check if starts with a known area code prefix
            const startsKnown = KNOWN_PREFIXES.some(p => combined.startsWith(p));
            if (!startsKnown) continue;

            // Attempt to sanitize
            const sanitized = sanitizeAndFixPhone(combined);
            if (sanitized) return sanitized;
        }
    }
    return null;
}

// ── Cookie helpers ─────────────────────────────────────────────────
function makeCookieStore() {
    const cookies = [];
    return {
        update(response) {
            const headers = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
            const raw = Array.isArray(headers) ? headers : [headers].filter(Boolean);
            raw.forEach(str => { if (str) { const p = str.split(';'); if (p.length) cookies.push(p[0]); } });
        },
        get() { return cookies.join('; '); }
    };
}

// ── Login and return cookie store ─────────────────────────────────
async function login() {
    const store = makeCookieStore();
    const pageRes = await fetch(`${BASE_URL}/index.php`);
    store.update(pageRes);

    const params = new URLSearchParams();
    params.append('useremi', USUARIO);
    params.append('pasemi', PASSWORD);

    const loginRes = await fetch(`${BASE_URL}/emivali.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': store.get() },
        body: params.toString(),
        redirect: 'manual'
    });
    store.update(loginRes);

    // Follow JS redirect if present
    const body = await loginRes.text();
    if (body.includes('window.location')) {
        const m = body.match(/window\.location\s*=\s*"([^"]+)"/);
        if (m) {
            const followRes = await fetch(`${BASE_URL}/${m[1]}`, { headers: { 'Cookie': store.get() } });
            store.update(followRes);
        }
    }

    return store;
}

// ── Fetch poliza detail and extract phone, direccion, observaciones ─
async function fetchPolizaData(operacion, store) {
    const res = await fetch(`${BASE_URL}/muestro-polizas.php?prop=${operacion}`, {
        headers: { 'Cookie': store.get() }
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    let telefonoField = '';
    let direccionField = '';
    let observacionesField = '';

    // Walk all elements looking for label -> value pairs
    $('div, td, span, p').each((_, el) => {
        const labelText = $(el).clone().children().remove().end().text().trim().toLowerCase();
        const nextEl = $(el).next();
        const nextVal = nextEl.find('strong').text().trim() || nextEl.text().trim();
        const sibVal = $(el).siblings('div').first().find('strong').text().trim();

        if (/^tel[eé]fono\s*[:\.]?\s*$/.test(labelText)) {
            telefonoField = nextVal || sibVal;
        }
        if (/^direcci[oó]n\s*[:\.]?\s*$/.test(labelText)) {
            direccionField = nextVal || sibVal;
        }
        if (/observaci[oó]n/.test(labelText)) {
            // Collect next 3 siblings
            let obs = '';
            $(el).nextAll().each((i, sib) => { if (i < 3) obs += ' ' + $(sib).text().trim(); });
            observacionesField += ' ' + obs;
        }
    });

    // Also scan all strong elements and their parent text for phone-like content
    const fullText = $('body').text();

    return { telefonoField, direccionField, observacionesField: observacionesField.trim(), fullText };
}

// ── Sleep ──────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main ───────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(65));
    console.log('📞 EXTRACCIÓN DE TELÉFONOS DESDE NRE — SEGUCar');
    console.log('='.repeat(65));
    console.log(`🔐 Conectando a ${BASE_URL} como ${USUARIO}...`);

    const store = await login();
    console.log('✅ Login OK\n');

    // Get all clients without phone (or invalid), paired with their first and last poliza
    const clientesBase = db.prepare(`
        SELECT c.id as cliente_id, c.nombre, c.telefono,
               MIN(p.operacion) as poliza_primera,
               MAX(p.operacion) as poliza_ultima
        FROM clientes c
        INNER JOIN polizas p ON c.id = p.cliente_id
        WHERE (c.telefono IS NULL OR c.telefono = '' OR length(c.telefono) < 10)
          AND NOT EXISTS (SELECT 1 FROM telefonos_invalidos ti WHERE ti.cliente_id = c.id)
        GROUP BY c.id
        ORDER BY c.nombre ASC
    `).all();

    console.log(`🔍 Clientes sin teléfono válido: ${clientesBase.length}`);
    console.log('─'.repeat(65));

    let encontrados = 0;
    let noEncontrados = 0;
    let errores = 0;
    const log = [];

    for (let i = 0; i < clientesBase.length; i++) {
        const c = clientesBase[i];
        const progress = `(${i + 1}/${clientesBase.length})`;

        // Try last poliza first, then first poliza
        const polizasToTry = [...new Set([c.poliza_ultima, c.poliza_primera])].filter(Boolean);
        let foundPhone = null;
        let sourceOp = null;
        let sourceField = null;

        for (const op of polizasToTry) {
            try {
                process.stdout.write(`  ${progress} Checking op ${op} (${c.nombre.substring(0, 30)})...`);
                const data = await fetchPolizaData(op, store);

                // Priority: Teléfono field → Dirección (inline) → Observaciones → Full text
                const sources = [
                    { text: data.telefonoField, name: 'telefono' },
                    { text: data.direccionField, name: 'direccion' },
                    { text: data.observacionesField, name: 'observaciones' },
                ];

                for (const src of sources) {
                    const phone = extractPhone(src.text);
                    if (phone) {
                        foundPhone = phone;
                        sourceOp = op;
                        sourceField = src.name;
                        break;
                    }
                }

                if (foundPhone) {
                    process.stdout.write(` ✅ ENCONTRADO (${sourceField}): ${foundPhone}\n`);
                    break; // no need to try other polizas
                } else {
                    process.stdout.write(` ❌ no phone\n`);
                }

                await sleep(DELAY_MS);
            } catch (err) {
                process.stdout.write(` ⚠️ ERROR: ${err.message}\n`);
                errores++;
                await sleep(DELAY_MS * 2);
            }
        }

        if (foundPhone) {
            // Update only if still empty (never overwrite manually entered data)
            const current = db.prepare('SELECT telefono FROM clientes WHERE id = ?').get(c.cliente_id);
            const isStillEmpty = !current.telefono || current.telefono === '' || current.telefono.length < 10;

            if (isStillEmpty) {
                db.prepare('UPDATE clientes SET telefono = ? WHERE id = ?').run(foundPhone, c.cliente_id);
                encontrados++;
                log.push(`✅ ${c.nombre} → ${foundPhone} (op ${sourceOp}, campo: ${sourceField})`);
            } else {
                log.push(`⏭️  ${c.nombre} → ya tenía teléfono: ${current.telefono} (no sobreescrito)`);
            }
        } else {
            noEncontrados++;
            log.push(`❌ ${c.nombre} → sin teléfono (ops: ${polizasToTry.join(', ')})`);
        }
    }

    console.log('\n' + '='.repeat(65));
    console.log(`✅ Encontrados y actualizados: ${encontrados}`);
    console.log(`❌ Sin teléfono en NRE:        ${noEncontrados}`);
    console.log(`⚠️  Errores de red:              ${errores}`);
    console.log('='.repeat(65));
    console.log('\n📋 DETALLE:\n');
    log.forEach(l => console.log(' ', l));
}

main().catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
