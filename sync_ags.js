/**
 * sync_ags.js
 * Sincronización automática con portal AGS (Agrosalta CABA)
 * Equivalente a sync_nre.js pero para el sistema AGS.
 *
 * Endpoints usados:
 *  - POST /validousuario.php          → login
 *  - GET  /prsesion.php?...           → establecer sesión
 *  - POST /consulvigprod3.php         → pólizas vigentes por productor
 *  - GET  /veonorendipr.php           → cuotas impagas (todas)
 */

'use strict';

const https = require('https');
const qs = require('querystring');
const db = require('./database');

// ─── Configuración ───────────────────────────────────────────────────────────
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
            res.on('end', () => resolve({ data, cookie: setCookie, status: res.statusCode, location: res.headers['location'] }));
        });
        req.on('error', reject);
        if (postBody) req.write(postBody);
        req.end();
    });
}

// ─── Login y sesión ───────────────────────────────────────────────────────────
async function loginAGS() {
    // 1. Login AJAX
    const r1 = await httpReq('POST', '/validousuario.php', { user: AGS_USER, pass: AGS_PASS, usuvir: 'on' }, '');
    const loginData = JSON.parse(r1.data);
    if (loginData.estado !== 2) throw new Error(`AGS login fallido: estado=${loginData.estado} - ${loginData.desc}`);

    // 2. Establecer sesión PHP
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

    // Parsear tabla HTML
    const polizas = [];
    const rows = [...(json.tabla || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '\t').replace(/\t+/g, '\t').replace(/&nbsp;/g, '').trim())
        .filter(r => r.length > 5);

    for (let i = 1; i < rows.length; i++) { // skip header
        const cols = rows[i].split('\t').map(c => c.trim());
        if (cols.length < 9) continue;
        // cols: [0]Productor [1]Agencia [2]Asegurado [3]Póliza [4]Vehículo [5]Año [6]Cober [7]Patente [8]FinVig [9]Suma [10]Motor [11]Chasis [12]Item [13]Descri [14]EqGas [15]Premio [16]CostoAP [17]Propuesta
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

// ─── Obtener cuotas impagas ───────────────────────────────────────────────────
async function fetchCuotasImpagas(cookie) {
    const r = await httpReq('GET', '/veonorendipr.php', null, cookie);

    const deudas = {};
    const rows = [...r.data.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '\t').replace(/\t+/g, '\t').replace(/&nbsp;/g, '').trim())
        .filter(r => r.length > 5);

    for (let i = 1; i < rows.length; i++) {
        const cols = rows[i].split('\t').map(c => c.trim());
        // cols: [0]Asegurado [1]Póliza [2]Endoso [3]Propuesta [4]NroCuota [5]Vto [6]Importe [7]Saldo [8]Vehiculo [9]Cober [10]Patente [11]FinVig
        if (cols.length < 8) continue;
        const polizaNum = cols[1];
        if (!deudas[polizaNum]) {
            deudas[polizaNum] = { cuotas: 0, saldo: 0, fecha_vto: cols[5] };
        }
        deudas[polizaNum].cuotas++;
        deudas[polizaNum].saldo += parseFloat(cols[7]) || 0;
        // Keep earliest due date
        if (cols[5] < deudas[polizaNum].fecha_vto) deudas[polizaNum].fecha_vto = cols[5];
    }
    return deudas;
}

// ─── Migración DB: agregar columna origen si no existe ───────────────────────
function migrarDB() {
    try { db.prepare("ALTER TABLE clientes ADD COLUMN origen TEXT DEFAULT 'NRE'").run(); } catch (e) {}
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
function upsertPolizaAGS(clienteId, p, deuda) {
    const cuotasDebe = deuda ? deuda.cuotas : 0;
    const saldoPendiente = deuda ? deuda.saldo : 0;
    const fechaVto = deuda ? deuda.fecha_vto : p.fin_vigencia;

    const existente = db.prepare("SELECT id FROM polizas WHERE operacion = ? AND aseguradora = 'AGS'").get(p.poliza);
    if (existente) {
        db.prepare(`
            UPDATE polizas SET
                cliente_id = ?,
                vehiculo = ?,
                patente = ?,
                fin_vigencia_poliza = ?,
                fecha_vencimiento = ?,
                cuotas_debe = ?,
                saldo_pendiente = ?,
                suma_asegurada = ?,
                aseguradora = 'AGS'
            WHERE operacion = ? AND aseguradora = 'AGS'
        `).run(clienteId, p.vehiculo, p.patente, p.fin_vigencia, fechaVto, cuotasDebe, saldoPendiente, p.suma_asegurada, p.poliza);
        return { accion: 'actualizada' };
    } else {
        db.prepare(`
            INSERT INTO polizas (
                cliente_id, operacion, vehiculo, patente,
                fin_vigencia_poliza, fecha_vencimiento,
                cuotas_debe, saldo_pendiente, suma_asegurada, aseguradora,
                estado, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AGS', 'vigente', datetime('now'))
        `).run(clienteId, p.poliza, p.vehiculo, p.patente, p.fin_vigencia, fechaVto, cuotasDebe, saldoPendiente, p.suma_asegurada);
        return { accion: 'creada' };
    }
}

// ─── Función principal de sincronización ─────────────────────────────────────
async function syncAGS() {
    console.log('🔵 Iniciando sync AGS...');

    // Migración DB
    migrarDB();

    // Login
    const cookie = await loginAGS();

    // Fecha de hoy en formato dd/mm/yyyy
    const hoy = new Date();
    const fecha = `${String(hoy.getDate()).padStart(2,'0')}/${String(hoy.getMonth()+1).padStart(2,'0')}/${hoy.getFullYear()}`;

    // Obtener cuotas impagas (para todas las pólizas)
    console.log('   📋 Obteniendo cuotas impagas...');
    const deudas = await fetchCuotasImpagas(cookie);
    console.log(`   → ${Object.keys(deudas).length} pólizas con cuotas impagas`);

    // Obtener pólizas vigentes de cada productor
    let totalCreadas = 0, totalActualizadas = 0;

    for (const orga of PRODUCTORES) {
        console.log(`   🔍 Obteniendo pólizas vigentes para productor ${orga}...`);
        const polizas = await fetchPolizasVigentes(cookie, orga, fecha);
        console.log(`   → ${polizas.length} pólizas vigentes`);

        for (const p of polizas) {
            const cliente = upsertClienteAGS(p.asegurado);
            const deuda = deudas[p.poliza] || null;
            const { accion } = upsertPolizaAGS(cliente.id, p, deuda);
            if (accion === 'creada') totalCreadas++;
            else totalActualizadas++;
        }
    }

    const resultado = {
        fecha,
        polizas_creadas: totalCreadas,
        polizas_actualizadas: totalActualizadas,
        con_deuda: Object.keys(deudas).length
    };

    console.log(`✅ Sync AGS completado: ${totalCreadas} nuevas, ${totalActualizadas} actualizadas, ${Object.keys(deudas).length} con deuda`);
    return resultado;
}

module.exports = { syncAGS };

// Ejecutar directamente si se llama como script
if (require.main === module) {
    syncAGS().then(r => {
        console.log('Resultado:', JSON.stringify(r, null, 2));
        process.exit(0);
    }).catch(e => {
        console.error('Error:', e.message);
        process.exit(1);
    });
}
