#!/usr/bin/env node
/**
 * extraer_telefonos_completo.js
 * ─────────────────────────────────────────────────────────────────
 * Completa teléfonos FALTANTES para TODOS los clientes (584 sin celular).
 *
 * FUENTE 1 (sin red, instantáneo):
 *   Busca en polizas_historicas por nombre del cliente — si hay teléfono
 *   registrado en una póliza histórica, lo usa para actualizar clientes.
 *
 * FUENTE 2 (red — NRE portal):
 *   Para los que queden sin tel tras la Fuente 1, consulta NRE buscando
 *   en Teléfono, Dirección y Observaciones de la última y primera póliza.
 *
 * REGLAS:
 *   - NUNCA sobreescribe un teléfono que ya existe y es válido.
 *   - NUNCA borra ni modifica datos existentes.
 *   - Normaliza al formato E.164 549XXXXXXXXXX.
 * ─────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const cheerio = require('cheerio');
const db = require('./database');

const BASE_URL = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
const USUARIO  = process.env.SISTEMA_USUARIO;
const PASSWORD = process.env.SISTEMA_PASSWORD;
const DELAY_MS = 700;

// ── Phone sanitizer ───────────────────────────────────────────────
function sanitizeAndFixPhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
    if (digits.startsWith('54') && digits.length >= 13) digits = digits.slice(2);
    if (digits.startsWith('9') && digits.length === 11) digits = digits.slice(1);
    if (digits.length === 10) digits = '549' + digits;
    if (digits.length === 13 && digits.startsWith('549')) return digits;
    return null;
}

// ── Extract phone from text using sliding-window digit grouping ────
function extractPhone(text) {
    if (!text) return null;
    const digitGroups = [];
    const rx = /\d+/g;
    let m;
    while ((m = rx.exec(text)) !== null) {
        digitGroups.push({ val: m[0], idx: m.index });
    }
    const PREFIXES = ['223', '221', '2235', '2236', '2234', '2267', '2266', '2265',
                      '2254', '2255', '2251', '2252', '2257', '2261', '2262',
                      '2281', '2282', '2291', '2292', '2293', '2294', '2296', '2297',
                      '351', '341', '11'];
    for (let i = 0; i < digitGroups.length; i++) {
        for (let j = i; j <= Math.min(i + 3, digitGroups.length - 1); j++) {
            const combined = digitGroups.slice(i, j + 1).map(g => g.val).join('');
            if (combined.length < 9 || combined.length > 15) continue;
            if (!PREFIXES.some(p => combined.startsWith(p))) continue;
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

// ── Login to NRE ──────────────────────────────────────────────────
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
    const body = await loginRes.text();
    if (body.includes('window.location')) {
        const mx = body.match(/window\.location\s*=\s*"([^"]+)"/);
        if (mx) {
            const followRes = await fetch(`${BASE_URL}/${mx[1]}`, { headers: { 'Cookie': store.get() } });
            store.update(followRes);
        }
    }
    return store;
}

// ── Fetch poliza detail from NRE ─────────────────────────────────
async function fetchPolizaData(operacion, store) {
    const res = await fetch(`${BASE_URL}/muestro-polizas.php?prop=${operacion}`, {
        headers: { 'Cookie': store.get() }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    let telefonoField = '', direccionField = '', observacionesField = '';
    $('div').each((_, el) => {
        const label = $(el).clone().children().remove().end().text().trim();
        const nextStrong = $(el).next().find('strong').text().trim();
        const nextText = $(el).next().text().trim();
        const val = nextStrong || nextText;
        if (/^tel[eé]f/i.test(label)) telefonoField = val;
        if (/^direcci/i.test(label)) direccionField = val;
        if (/observaci/i.test(label)) {
            let obs = '';
            $(el).nextAll().each((i, sib) => { if (i < 3) obs += ' ' + $(sib).text().trim(); });
            observacionesField += ' ' + obs.trim();
        }
    });
    return { telefonoField, direccionField, observacionesField: observacionesField.trim() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Update helper — safe (never overwrites valid phone) ─────────────
function safeUpdatePhone(clienteId, phone) {
    const current = db.prepare('SELECT telefono FROM clientes WHERE id = ?').get(clienteId);
    if (!current) return false;
    const isEmpty = !current.telefono || current.telefono === '' || current.telefono.length < 10;
    if (!isEmpty) return false; // don't overwrite
    db.prepare('UPDATE clientes SET telefono = ? WHERE id = ?').run(phone, clienteId);
    return true;
}

// ═══════════════════════════════════════════════════════════════════
async function main() {
    console.log('='.repeat(65));
    console.log('📞 EXTRACCIÓN COMPLETA DE TELÉFONOS — SEGUCar');
    console.log('='.repeat(65));

    // ── All clients without valid phone ───────────────────────────
    const todosSinTel = db.prepare(`
        SELECT c.id as cliente_id, c.nombre, c.telefono
        FROM clientes c
        WHERE (c.telefono IS NULL OR c.telefono = '' OR length(c.telefono) < 10)
        ORDER BY c.nombre ASC
    `).all();

    console.log(`\n📊 Total clientes sin teléfono válido: ${todosSinTel.length}`);

    let fase1 = 0, fase2 = 0, sinDatos = 0;
    const log = [];

    // ═══════════════════════════════════════════════════════════════
    // FASE 1 — polizas_historicas (sin red, instantáneo)
    // ═══════════════════════════════════════════════════════════════
    console.log('\n─'.repeat(65));
    console.log('⚡ FASE 1: Buscando en polizas_historicas (por nombre)...');
    console.log('─'.repeat(65));

    const aun_sin_tel = [];

    for (const c of todosSinTel) {
        // Normalize name for fuzzy matching
        const nombreNorm = c.nombre.trim().toUpperCase().replace(/\s+/g, ' ');

        // Try exact match first, then partial match
        const matches = db.prepare(`
            SELECT ph.telefono, ph.operacion
            FROM polizas_historicas ph
            WHERE TRIM(UPPER(ph.nombre)) = ?
              AND ph.telefono IS NOT NULL AND ph.telefono != ''
            ORDER BY ph.operacion DESC
            LIMIT 1
        `).get(nombreNorm);

        if (matches && matches.telefono) {
            const sanitized = sanitizeAndFixPhone(matches.telefono) || extractPhone(matches.telefono);
            if (sanitized) {
                const updated = safeUpdatePhone(c.cliente_id, sanitized);
                if (updated) {
                    fase1++;
                    process.stdout.write(`  ✅ [HIST] ${c.nombre} → ${sanitized} (op ${matches.operacion})\n`);
                    log.push(`✅ [HIST] ${c.nombre} → ${sanitized}`);
                    continue;
                }
            }
        }

        // Also check if they have a poliza activa or historica for NRE lookup
        const polizas = db.prepare(`
            SELECT operacion FROM polizas WHERE cliente_id = ?
            ORDER BY operacion DESC
        `).all(c.cliente_id);

        aun_sin_tel.push({ ...c, polizas_ops: polizas.map(p => p.operacion) });
    }

    console.log(`\n✅ Fase 1 completada: ${fase1} teléfonos actualizados desde historial`);
    console.log(`📋 Quedan ${aun_sin_tel.length} clientes para Fase 2 (NRE)`);

    // ═══════════════════════════════════════════════════════════════
    // FASE 2 — NRE portal (solo los que tienen pólizas activas)
    // ═══════════════════════════════════════════════════════════════
    const paraFase2 = aun_sin_tel.filter(c => c.polizas_ops.length > 0);
    const sinPoliza  = aun_sin_tel.filter(c => c.polizas_ops.length === 0);

    console.log('\n─'.repeat(65));
    console.log(`🌐 FASE 2: Consultando NRE para ${paraFase2.length} clientes con póliza activa...`);
    console.log(`  (${sinPoliza.length} sin póliza activa: no consultables vía NRE)`);
    console.log('─'.repeat(65));

    if (paraFase2.length > 0) {
        console.log('🔐 Iniciando sesión en NRE...');
        const store = await login();
        console.log('✅ Login OK\n');

        for (let i = 0; i < paraFase2.length; i++) {
            const c = paraFase2[i];
            const progress = `(${i + 1}/${paraFase2.length})`;

            // Try last poliza first, then first poliza
            const opsToTry = [...new Set([c.polizas_ops[0], c.polizas_ops[c.polizas_ops.length - 1]])].filter(Boolean);
            let foundPhone = null;
            let sourceOp = null;
            let sourceField = null;

            for (const op of opsToTry) {
                try {
                    process.stdout.write(`  ${progress} Op ${op} (${c.nombre.substring(0, 28)})...`);
                    const data = await fetchPolizaData(op, store);

                    const sources = [
                        { text: data.telefonoField,    name: 'telefono' },
                        { text: data.direccionField,   name: 'direccion' },
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
                        process.stdout.write(` ✅ ${foundPhone} [${sourceField}]\n`);
                        break;
                    } else {
                        process.stdout.write(` ❌ no phone\n`);
                    }

                    await sleep(DELAY_MS);
                } catch (err) {
                    process.stdout.write(` ⚠️ ${err.message}\n`);
                    await sleep(DELAY_MS * 2);
                }
            }

            if (foundPhone) {
                const updated = safeUpdatePhone(c.cliente_id, foundPhone);
                if (updated) {
                    fase2++;
                    log.push(`✅ [NRE] ${c.nombre} → ${foundPhone} (op ${sourceOp}, ${sourceField})`);
                }
            } else {
                sinDatos++;
                log.push(`❌ ${c.nombre} → sin teléfono (ops: ${opsToTry.join(', ')})`);
            }
        }
    }

    // Clients without any poliza (can't query NRE)
    sinPoliza.forEach(c => {
        sinDatos++;
        log.push(`⚠️  ${c.nombre} → sin póliza activa (no consultable)`);
    });

    // ═══════════════════════════════════════════════════════════════
    // RESUMEN FINAL
    // ═══════════════════════════════════════════════════════════════
    const totalActualizados = fase1 + fase2;

    // Re-count coverage
    const nuevoCnt = db.prepare(`
        SELECT COUNT(*) as con FROM clientes 
        WHERE telefono IS NOT NULL AND telefono != '' AND length(telefono) >= 10
    `).get();
    const sinTelFinal = db.prepare(`
        SELECT COUNT(*) as sin FROM clientes
        WHERE telefono IS NULL OR telefono = '' OR length(telefono) < 10
    `).get();

    console.log('\n' + '='.repeat(65));
    console.log('📊 RESUMEN FINAL');
    console.log('='.repeat(65));
    console.log(`  ✅ Actualizados desde historial (Fase 1): ${fase1}`);
    console.log(`  ✅ Actualizados desde NRE       (Fase 2): ${fase2}`);
    console.log(`  ─────────────────────────────────────────`);
    console.log(`  ✅ TOTAL ACTUALIZADOS:                    ${totalActualizados}`);
    console.log(`  ❌ Sin teléfono en ninguna fuente:        ${sinDatos}`);
    console.log('');
    console.log(`  📱 Clientes CON teléfono ahora:   ${nuevoCnt.con}`);
    console.log(`  📵 Clientes SIN teléfono ahora:   ${sinTelFinal.sin}`);
    console.log('='.repeat(65));

    console.log('\n📋 DETALLE:\n');
    log.forEach(l => console.log(' ', l));
}

main().catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
