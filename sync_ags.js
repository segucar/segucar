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

// ─── Configuración ────────────────────────────────────────────────────────────
const AGS_HOST = 'www.agsnet.com.ar';
const AGS_USER = process.env.AGS_USUARIO || '157101054';
const AGS_PASS = process.env.AGS_PASSWORD || 'nocturno';

// Códigos de productor que usamos
const PRODUCTORES = ['123701054', '123901054'];

// AGS siempre factura en 4 cuotas
const AGS_TOTAL_CUOTAS = 4;

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

// ─── Helpers de Cronograma AGS (4 cuotas fijas) ──────────────────────────────
function calcularFechaCuotaAGS(finVigenciaStr, mesesAntes) {
    const parts = String(finVigenciaStr).split('T')[0].split('-');
    if (parts.length !== 3) return finVigenciaStr;
    let y = parseInt(parts[0], 10);
    let m = parseInt(parts[1], 10) - 1; // 0-indexed
    let d = parseInt(parts[2], 10);

    let targetMonth = m - mesesAntes;
    while (targetMonth < 0) {
        targetMonth += 12;
        y -= 1;
    }
    const daysInMonth = new Date(y, targetMonth + 1, 0).getDate();
    const safeDay = Math.min(d, daysInMonth);

    const mm = String(targetMonth + 1).padStart(2, '0');
    const dd = String(safeDay).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
}

function generarCronogramaCuotasAGS(finVigencia, premio, historialExistente = null) {
    const hoyStr = new Date().toISOString().slice(0, 10);
    const montoCuota = premio > 0 ? Math.round((premio / AGS_TOTAL_CUOTAS) * 100) / 100 : 0;
    
    let histMap = {};
    if (historialExistente) {
        try {
            const parsed = typeof historialExistente === 'string' ? JSON.parse(historialExistente) : historialExistente;
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (item && item.nro_cuota) histMap[item.nro_cuota] = item;
                }
            }
        } catch(e) {}
    }

    const cuotas = [];
    for (let i = 1; i <= AGS_TOTAL_CUOTAS; i++) {
        const vto = calcularFechaCuotaAGS(finVigencia, AGS_TOTAL_CUOTAS - i + 1);
        const existing = histMap[i];

        if (existing) {
            cuotas.push({
                nro_cuota: i,
                vto_cuota: existing.vto_cuota || vto,
                saldo_cli: existing.saldo_cli !== undefined ? existing.saldo_cli : (existing.estado === 'PAGADA' ? 0 : montoCuota),
                estado: existing.estado || (vto < hoyStr ? 'PAGADA' : 'PENDIENTE'),
                fecha_pago: existing.fecha_pago || (existing.estado === 'PAGADA' ? 'Registrado en AGS' : null),
                lote: existing.lote || 'Sincronizado con AGS'
            });
        } else {
            // Por defecto: cuotas pasadas que no están en mora se consideran pagadas; la cuota actual/futura está pendiente
            const esPasada = vto < hoyStr;
            cuotas.push({
                nro_cuota: i,
                vto_cuota: vto,
                saldo_cli: esPasada ? 0 : montoCuota,
                estado: esPasada ? 'PAGADA' : 'PENDIENTE',
                fecha_pago: esPasada ? 'Registrado en AGS' : null,
                lote: 'Sincronizado con AGS'
            });
        }
    }

    // Determinar próxima cuota activa / cuota impaga
    const cuotasImpagas = cuotas.filter(c => c.estado === 'PENDIENTE' || c.saldo_cli > 0);
    const cuotasVencidas = cuotasImpagas.filter(c => c.vto_cuota && c.vto_cuota < hoyStr);

    let nroCuotaActiva = AGS_TOTAL_CUOTAS;
    let fechaVtoActiva = finVigencia;
    let cuotasDebe = cuotasVencidas.length;
    let saldoPendiente = cuotasImpagas.reduce((sum, c) => sum + (parseFloat(c.saldo_cli) || 0), 0);

    if (cuotasVencidas.length > 0) {
        // Hay cuotas vencidas impagas -> la activa es la primera vencida
        cuotasVencidas.sort((a, b) => (a.vto_cuota < b.vto_cuota ? -1 : 1));
        nroCuotaActiva = cuotasVencidas[0].nro_cuota;
        fechaVtoActiva = cuotasVencidas[0].vto_cuota;
    } else if (cuotasImpagas.length > 0) {
        // No hay mora, próxima cuota a vencer
        cuotasImpagas.sort((a, b) => (a.vto_cuota < b.vto_cuota ? -1 : 1));
        nroCuotaActiva = cuotasImpagas[0].nro_cuota;
        fechaVtoActiva = cuotasImpagas[0].vto_cuota;
    }

    return {
        cuotas,
        nro_cuota: nroCuotaActiva,
        fecha_vencimiento: fechaVtoActiva,
        cuotas_debe: cuotasDebe,
        saldo_pendiente: saldoPendiente
    };
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
    let cliente = db.prepare("SELECT * FROM clientes WHERE nombre = ? AND origen = 'AGS'").get(asegurado);
    if (!cliente) {
        const info = db.prepare("INSERT INTO clientes (nombre, origen) VALUES (?, 'AGS')").run(asegurado);
        cliente = { id: info.lastInsertRowid, nombre: asegurado, origen: 'AGS' };
    }
    return cliente;
}

// ─── Upsert póliza AGS ───────────────────────────────────────────────────────
function upsertPolizaAGS(clienteId, p) {
    const existente = db.prepare("SELECT id, cuotas_debe, saldo_pendiente, cuotas_historial, nro_cuota FROM polizas WHERE operacion = ? AND aseguradora = 'AGS'").get(p.poliza);

    const cronograma = generarCronogramaCuotasAGS(p.fin_vigencia, p.premio, existente ? existente.cuotas_historial : null);
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
    console.log('🔵 Iniciando sync AGS...');

    migrarDB();

    const cookie = await loginAGS();

    // Fecha de hoy en formato dd/mm/yyyy para el portal
    const hoy = new Date();
    const fecha = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;

    // NOTA: NO usamos veonorendipr.php porque muestra Saldo BROKER (no Saldo Cliente)
    // Las cuotas del cliente las gestiona el productor manualmente.

    let totalCreadas = 0, totalActualizadas = 0;

    for (const orga of PRODUCTORES) {
        console.log(`   🔍 Pólizas vigentes para productor ${orga}...`);
        const polizas = await fetchPolizasVigentes(cookie, orga, fecha);
        console.log(`   → ${polizas.length} pólizas`);

        for (const p of polizas) {
            const cliente = upsertClienteAGS(p.asegurado);
            const { accion } = upsertPolizaAGS(cliente.id, p);
            if (accion === 'creada') totalCreadas++;
            else totalActualizadas++;
        }
    }

    // Marcar como grucar_activo=0 cualquier poliza AGS que pueda haber quedado con grucar activado
    db.prepare("UPDATE polizas SET grucar_activo = 0 WHERE aseguradora = 'AGS'").run();

    const resultado = { fecha, polizas_creadas: totalCreadas, polizas_actualizadas: totalActualizadas };
    console.log(`✅ Sync AGS: ${totalCreadas} nuevas, ${totalActualizadas} actualizadas`);
    return resultado;
}

module.exports = { syncAGS, generarCronogramaCuotasAGS, calcularFechaCuotaAGS };

if (require.main === module) {
    syncAGS().then(r => {
        console.log('Resultado:', JSON.stringify(r, null, 2));
        process.exit(0);
    }).catch(e => {
        console.error('Error:', e.message);
        process.exit(1);
    });
}
