/**
 * sync_ags.js
 * Sincronización automática con portal AGS (Agrosalta CABA)
 *
 * IMPORTANTE — diferencias con NRE:
 *  - AGS: 4 cuotas fijas por póliza (no variable)
 *  - Saldo Cli ≠ Saldo Broker:
 *      · veonorendipr.php = "Cuotas cobradas NO rendidas" = SALDO BROKER (cliente ya pagó)
 *      · Para saldo real del cliente necesitamos otro endpoint → por ahora NO tocamos cuotas_debe
 *  - AGS no usa GRUCAR → grucar_activo = 0 siempre
 *
 * Endpoints usados:
 *  - POST /validousuario.php     → login
 *  - GET  /prsesion.php?...      → establecer sesión
 *  - POST /consulvigprod3.php    → pólizas vigentes por productor (datos de renovación)
 */

'use strict';

const https = require('https');
const qs = require('querystring');
const db = require('./database');
const { generarCronogramaCuotasAGS, calcularFechaCuotaAGS, AGS_TOTAL_CUOTAS } = require('./ags_helpers');

// ─── Configuración ────────────────────────────────────────────────────────────
const AGS_HOST = 'www.agsnet.com.ar';
const AGS_USER = process.env.AGS_USUARIO || '157101054';
const AGS_PASS = process.env.AGS_PASSWORD || 'nocturno';

// Códigos de productor que usamos
const PRODUCTORES = ['123701054', '123901054'];

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────
function httpReq(method, path, body, cookies, referer) {
    return new Promise((resolve, reject) => {
        const postBody = body ? qs.stringify(body) : '';
        const options = {
            hostname: AGS_HOST,
            path,
            method,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': postBody ? Buffer.byteLength(postBody) : 0,
                'User-Agent': 'Mozilla/5.0 (compatible; SEGUCar-Sync/1.0)',
                'Cookie': cookies || '',
                'Referer': referer || `https://${AGS_HOST}/espaciopr.php`,
                'Accept': 'text/html,application/json,*/*',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            const setCookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ data, cookie: setCookie, status: res.statusCode }));
        });
        req.on('error', reject);
        if (postBody) req.write(postBody);
        req.end();
    });
}

// ─── Login y sesión ───────────────────────────────────────────────────────────
async function loginAGS() {
    const r1 = await httpReq('POST', '/validousuario.php', { user: AGS_USER, pass: AGS_PASS, usuvir: 'on' }, '');
    const loginData = JSON.parse(r1.data);
    if (loginData.estado !== 2) throw new Error(`AGS login fallido: estado=${loginData.estado} - ${loginData.desc}`);

    const sessUrl = `/prsesion.php?login=1&orga=${loginData.bdorganiz}&nom=${loginData.bdusuario}&mail=${encodeURIComponent(loginData.bdemail)}&tipo=${loginData.bdtipo}&usuvir=1&idusuario=${loginData.bdid}&identifusuario=${loginData.bdidentif}&usuarioags=0`;
    const r2 = await httpReq('GET', sessUrl, null, '');
    const cookie = r2.cookie;
    if (!cookie) throw new Error('AGS: no se pudo obtener cookie de sesión');
    console.log(`   ✅ AGS login OK (${loginData.bdusuario} - ${loginData.bdnombre})`);
    return cookie;
}

// ─── Obtener pólizas vigentes por productor ───────────────────────────────────
async function fetchPolizasVigentes(cookie, orga, fecha) {
    const r = await httpReq('POST', '/consulvigprod3.php', { age: '', orga, fecha }, cookie,
        `https://${AGS_HOST}/consulvigprod2.php?orga=${orga}&qs=pr&age=&fhasta=${fecha}`
    );

    let json;
    try { json = JSON.parse(r.data); } catch (e) { throw new Error(`AGS consulvigprod3 no devolvió JSON para orga=${orga}`); }
    if (json.estado !== 0) throw new Error(`AGS consulvigprod3 error: ${json.desc}`);

    const polizas = [];
    const rows = [...(json.tabla || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '\t').replace(/\t+/g, '\t').replace(/&nbsp;/g, '').trim())
        .filter(r => r.length > 5);

    for (let i = 1; i < rows.length; i++) {
        const cols = rows[i].split('\t').map(c => c.trim());
        if (cols.length < 9) continue;
        // [0]Productor [1]Agencia [2]Asegurado [3]Póliza [4]Vehículo [5]Año [6]Cober [7]Patente [8]FinVig [9]Suma [15]Premio [17]Propuesta
        polizas.push({
            productor: cols[0],
            asegurado: cols[2],
            poliza: cols[3],
            vehiculo: cols[4] + (cols[5] ? ' ' + cols[5] : ''),
            cobertura: cols[6],
            patente: cols[7],
            fin_vigencia: cols[8], // YYYY-MM-DD
            suma_asegurada: parseFloat(cols[9]) || 0,
            premio: parseFloat(cols[15]) || 0,
            propuesta: cols[17] || ''
        });
    }
    return polizas;
}

// ─── Helpers de Cronograma AGS importados de ags_helpers.js ──────────────────
// (calcularFechaCuotaAGS, generarCronogramaCuotasAGS, AGS_TOTAL_CUOTAS)


// ─── Obtener cuotas cobradas "A Rendir" (veonorendipr.php) ───────────────────
async function fetchPagosNoRendidos(cookie) {
    try {
        const r = await httpReq('GET', '/veonorendipr.php', null, cookie);
        const rows = [...(r.data || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
            .map(m => m[1].replace(/<[^>]+>/g, '\t').replace(/\t+/g, '\t').replace(/&nbsp;/g, '').trim())
            .filter(r => r.length > 5);

        const map = {};
        for (let i = 1; i < rows.length; i++) {
            const cols = rows[i].split('\t').map(c => c.trim());
            const poliza = cols[1];
            const nroCuotaStr = cols[4] || '';
            const nroCuota = parseInt(nroCuotaStr.split('/')[0].trim(), 10);
            if (!poliza || isNaN(nroCuota)) continue;

            if (!map[poliza]) map[poliza] = new Set();
            map[poliza].add(nroCuota);
        }
        return map;
    } catch(e) {
        console.error('   ⚠️ Error leyendo veonorendipr.php:', e.message);
        return {};
    }
}

// ─── Parser de detalle de póliza (muestro-polizasmod.php) ─────────────────────
function parseMuestroPolizasMod(html) {
    if (!html) return null;
    const cuotas = [];
    const cuotaMatches = [...html.matchAll(/<tr[^>]*>\s*<td[^>]*><strong>(\d+)<\/strong><\/td>\s*<td[^>]*><strong>(\d{2}\/\d{2}\/\d{4})<\/strong><\/td>\s*<td[^>]*><strong>\$\s*([\d\.,]+)<\/strong><\/td>\s*<td[^>]*><strong>\$\s*([\d\.,]+)<\/strong><\/td>\s*<\/tr>/gi)];

    for (const m of cuotaMatches) {
        const nroCuota = parseInt(m[1], 10);
        const vtoParts = m[2].split('/');
        const vtoIso = `${vtoParts[2]}-${vtoParts[1]}-${vtoParts[0]}`;
        const importe = parseFloat(m[3].replace(/\./g, '').replace(',', '.')) || 0;
        const saldo = parseFloat(m[4].replace(/\./g, '').replace(',', '.')) || 0;

        cuotas.push({
            nro_cuota: nroCuota,
            vto_cuota: vtoIso,
            importe,
            saldo_cli: saldo,
            estado: saldo <= 2500 ? 'PAGADA' : 'PENDIENTE',
            fecha_pago: saldo <= 2500 ? 'Registrado en AGS' : null,
            lote: 'Sincronizado con AGS'
        });
    }

    return cuotas.length > 0 ? cuotas : null;
}

// ─── Migración DB ─────────────────────────────────────────────────────────────
function migrarDB() {
    try { db.prepare("ALTER TABLE clientes ADD COLUMN origen TEXT DEFAULT 'NRE'").run(); } catch (e) {}
    try { db.prepare("ALTER TABLE polizas ADD COLUMN total_cuotas INTEGER DEFAULT 4").run(); } catch (e) {}
    try { db.prepare("ALTER TABLE polizas ADD COLUMN nro_cuota INTEGER DEFAULT 1").run(); } catch (e) {}
    try { db.prepare("ALTER TABLE polizas ADD COLUMN cuotas_historial TEXT").run(); } catch (e) {}
}

// ─── Upsert cliente AGS ───────────────────────────────────────────────────────
function upsertClienteAGS(asegurado) {
    if (!asegurado) return null;
    const cleanName = String(asegurado).trim();

    // 1. Buscar cliente existente por nombre normalizado (global, sin importar origen)
    // Se prioriza el registro que ya tenga teléfono válido
    let cliente = db.prepare(`
        SELECT * FROM clientes 
        WHERE norm(nombre) = norm(?) 
        ORDER BY (CASE WHEN telefono IS NOT NULL AND length(telefono) >= 10 THEN 0 ELSE 1 END), id ASC
    `).get(cleanName);

    // 2. Si existe un teléfono maestro guardado para este nombre, recuperarlo
    let masterPhone = null;
    try {
        const tm = db.prepare(`
            SELECT telefono 
            FROM telefonos_maestros 
            WHERE norm(nombre) = norm(?) 
              AND telefono IS NOT NULL 
              AND length(telefono) >= 10 
            ORDER BY updated_at DESC 
            LIMIT 1
        `).get(cleanName);
        if (tm && tm.telefono) masterPhone = tm.telefono;
    } catch(e) {}

    if (cliente) {
        // Si el cliente no tiene teléfono válido pero existe en telefonos_maestros, restaurarlo
        if ((!cliente.telefono || cliente.telefono.length < 10) && masterPhone) {
            db.prepare("UPDATE clientes SET telefono = ? WHERE id = ?").run(masterPhone, cliente.id);
            cliente.telefono = masterPhone;
            if (typeof db.guardarTelefonoMaestro === 'function') {
                db.guardarTelefonoMaestro(cliente.id, cleanName, masterPhone, 'AGS_restore');
            }
        }
    } else {
        // No existe: crear el cliente preservando el teléfono maestro si existía
        const info = db.prepare("INSERT INTO clientes (nombre, telefono, origen) VALUES (?, ?, 'AGS')").run(cleanName, masterPhone || null);
        cliente = { id: info.lastInsertRowid, nombre: cleanName, telefono: masterPhone || null, origen: 'AGS' };
        if (masterPhone && typeof db.guardarTelefonoMaestro === 'function') {
            db.guardarTelefonoMaestro(cliente.id, cleanName, masterPhone, 'AGS_restore');
        }
    }
    return cliente;
}

// ─── Upsert póliza AGS ───────────────────────────────────────────────────────
function upsertPolizaAGS(clienteId, p, pagosNoRendidosSet = null) {
    const existente = db.prepare("SELECT id, cuotas_debe, saldo_pendiente, cuotas_historial, nro_cuota FROM polizas WHERE operacion = ? AND aseguradora = 'AGS'").get(p.poliza);

    const cronograma = generarCronogramaCuotasAGS(
        p.fin_vigencia, 
        p.premio, 
        existente ? existente.cuotas_historial : null,
        p.detalleCuotas || null,
        pagosNoRendidosSet || null
    );
    const cuotasHistorialJson = JSON.stringify(cronograma.cuotas);

    if (existente) {
        db.prepare(`
            UPDATE polizas SET
                cliente_id          = ?,
                vehiculo            = ?,
                patente             = ?,
                fin_vigencia_poliza = ?,
                fecha_vencimiento   = ?,
                nro_cuota           = ?,
                cuotas_debe         = ?,
                saldo_pendiente     = ?,
                suma_asegurada      = ?,
                total_cuotas        = ?,
                cuotas_historial    = ?,
                aseguradora         = 'AGS',
                grucar_activo       = 0
            WHERE operacion = ? AND aseguradora = 'AGS'
        `).run(
            clienteId, p.vehiculo, p.patente, p.fin_vigencia, 
            cronograma.fecha_vencimiento, cronograma.nro_cuota,
            cronograma.cuotas_debe, cronograma.saldo_pendiente,
            p.suma_asegurada, AGS_TOTAL_CUOTAS, cuotasHistorialJson,
            p.poliza
        );
        return { accion: 'actualizada' };
    } else {
        db.prepare(`
            INSERT INTO polizas (
                cliente_id, operacion, vehiculo, patente,
                fin_vigencia_poliza, fecha_vencimiento, nro_cuota,
                cuotas_debe, saldo_pendiente, cuotas_historial,
                suma_asegurada, total_cuotas,
                aseguradora, grucar_activo,
                estado, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGS', 0, 'vigente', datetime('now'))
        `).run(
            clienteId, p.poliza, p.vehiculo, p.patente,
            p.fin_vigencia, cronograma.fecha_vencimiento, cronograma.nro_cuota,
            cronograma.cuotas_debe, cronograma.saldo_pendiente, cuotasHistorialJson,
            p.suma_asegurada, AGS_TOTAL_CUOTAS
        );
        return { accion: 'creada' };
    }
}

// ─── Función principal de sincronización ─────────────────────────────────────
async function syncAGS() {
    const startMs = Date.now();
    const countBefore = db.prepare("SELECT COUNT(*) as c FROM polizas WHERE aseguradora = 'AGS'").get().c;
    console.log(`🔵 [syncAGS] Iniciando sync AGS... Pólizas AGS actuales en DB: ${countBefore}`);

    migrarDB();

    const cookie = await loginAGS();

    // 1. Obtener pagos a rendir (veonorendipr.php)
    const pagosNoRendidosMap = await fetchPagosNoRendidos(cookie);
    console.log(`   📋 [syncAGS] Pagos 'A Rendir' cargados para ${Object.keys(pagosNoRendidosMap).length} pólizas`);

    // 2. Fecha de hoy en formato dd/mm/yyyy para el portal
    const hoy = new Date();
    const fecha = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;

    let totalCreadas = 0, totalActualizadas = 0, totalProcesadas = 0;
    const allPolizas = [];

    for (const orga of PRODUCTORES) {
        console.log(`   🔍 [syncAGS] Pólizas vigentes para productor ${orga}...`);
        const polizas = await fetchPolizasVigentes(cookie, orga, fecha);
        console.log(`   → [syncAGS] Productor ${orga}: ${polizas.length} pólizas obtenidas`);
        totalProcesadas += polizas.length;
        allPolizas.push(...polizas);
    }

    // 3. Consultar detalle de cuotas en vivo para cada póliza (lotes de 6)
    const batchSize = 6;
    for (let i = 0; i < allPolizas.length; i += batchSize) {
        const batch = allPolizas.slice(i, i + batchSize);
        await Promise.all(batch.map(async (p) => {
            if (!p.propuesta) return;
            try {
                const detHtml = await httpReq('GET', `/muestro-polizasmod.php?prop=${p.propuesta}`, null, cookie);
                p.detalleCuotas = parseMuestroPolizasMod(detHtml.data);
            } catch(e) {
                // Fallback automático al cálculo algorítmico si falla la conexión individual
            }
        }));
    }

    // 4. Guardar en Base de Datos
    for (const p of allPolizas) {
        const cliente = upsertClienteAGS(p.asegurado);
        const pagosSet = pagosNoRendidosMap[p.poliza] || null;
        const { accion } = upsertPolizaAGS(cliente.id, p, pagosSet);
        if (accion === 'creada') totalCreadas++;
        else totalActualizadas++;
    }

    // Marcar como grucar_activo=0 cualquier poliza AGS que pueda haber quedado con grucar activado
    db.prepare("UPDATE polizas SET grucar_activo = 0 WHERE aseguradora = 'AGS'").run();

    const countAfter = db.prepare("SELECT COUNT(*) as c FROM polizas WHERE aseguradora = 'AGS'").get().c;
    const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
    const resultado = { fecha, total_procesadas: totalProcesadas, polizas_creadas: totalCreadas, polizas_actualizadas: totalActualizadas, polizas_ags_en_db: countAfter, duracion_seg: durationSec };
    console.log(`✅ [syncAGS] Finalizado en ${durationSec}s: ${totalCreadas} nuevas, ${totalActualizadas} actualizadas. Total AGS en DB: ${countAfter} (antes: ${countBefore})`);
    return resultado;
}

module.exports = { syncAGS, generarCronogramaCuotasAGS, calcularFechaCuotaAGS, fetchPagosNoRendidos, parseMuestroPolizasMod };

if (require.main === module) {
    syncAGS().then(r => {
        console.log('Resultado:', JSON.stringify(r, null, 2));
        process.exit(0);
    }).catch(e => {
        console.error('Error:', e.message);
        process.exit(1);
    });
}
