/**
 * sync_nre.js - Módulo de Sincronización en Vivo con el Portal NRE Emisión
 * Permite traer Vencimientos (lisvtopol.php) y Deudas (lisdeupmo.php)
 * usando las credenciales SUA / sua directamente al sistema SEGUCar.
 */

const cheerio = require('cheerio');
const db = require('./database');

function sanitizeAndFixPhone(phone, clientCity = '') {
    if (!phone) return '';
    let s = String(phone).trim();
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

async function fetchWithRetry(url, options = {}, maxRetries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok || res.status === 302) return res;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
            }
        } catch (err) {
            if (attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return fetch(url, options);
}

async function loginNRE(usuario = 'SUA', password = 'sua') {
    const baseUrl = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
    let cookies = [];
    const getCookieString = () => cookies.join('; ');
    const updateCookies = (res) => {
        const setCookieHeaders = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        const rawCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
        rawCookies.forEach(str => {
            if (str) {
                const parts = str.split(';');
                if (parts.length > 0) cookies.push(parts[0]);
            }
        });
    };

    const loginPageRes = await fetchWithRetry(`${baseUrl}/index.php`);
    updateCookies(loginPageRes);

    const loginParams = new URLSearchParams();
    loginParams.append('useremi', usuario);
    loginParams.append('pasemi', password);

    const loginRes = await fetchWithRetry(`${baseUrl}/emivali.php`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': getCookieString()
        },
        body: loginParams.toString(),
        redirect: 'manual'
    });
    updateCookies(loginRes);

    return { baseUrl, getCookieString };
}

function parseFechaArg(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.trim().split('/');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return dateStr;
}

/**
 * Trae vencimientos y renovaciones desde lisvtopol.php (Vencimiento de Pólizas)
 */
async function syncVencimientosNRE(usuario, password, desdeStr, hastaStr) {
    const curYear = new Date().getFullYear();
    desdeStr = desdeStr || `01/01/${curYear}`;
    hastaStr = hastaStr || `31/12/${curYear}`;
    const { baseUrl, getCookieString } = await loginNRE(usuario, password);

    const params = new URLSearchParams();
    params.append('produ', "('9902073')");
    params.append('desde', desdeStr);
    params.append('hasta', hastaStr);

    const res = await fetchWithRetry(`${baseUrl}/lisvtopol.php`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': getCookieString()
        },
        body: params.toString()
    });

    const data = await res.json();
    if (!data.tabla) return { importados: 0, actualizados: 0, error: 'No se encontraron datos' };

    const $ = cheerio.load(data.tabla);
    let importados = 0;
    let actualizados = 0;

    const findClienteByName = db.prepare('SELECT id FROM clientes WHERE UPPER(TRIM(nombre)) = UPPER(TRIM(?)) LIMIT 1');
    const insertCliente = db.prepare('INSERT INTO clientes (nombre, telefono) VALUES (?, ?)');
    const updateClienteTel = db.prepare(`
        UPDATE clientes 
        SET telefono = COALESCE(NULLIF(?, ''), telefono) 
        WHERE id = ? 
          AND (telefono IS NULL OR telefono = '' OR length(telefono) < 10)
          AND NOT EXISTS (
              SELECT 1 FROM telefonos_invalidos ti WHERE ti.cliente_id = clientes.id
          )
    `);
    const findPoliza = db.prepare('SELECT id FROM polizas WHERE operacion = ?');
    const insertPoliza = db.prepare(`
        INSERT INTO polizas (cliente_id, operacion, seccion, tipo_vehiculo, patente, vehiculo, suma_asegurada, cod_prod, cuenta, fecha_vencimiento, fin_vigencia_poliza, renovada, cuotas_debe, estado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updatePoliza = db.prepare(`
        UPDATE polizas SET seccion = ?, tipo_vehiculo = ?, patente = ?, vehiculo = ?, suma_asegurada = ?, fin_vigencia_poliza = ?, renovada = ?, cuotas_debe = ?, estado = ?
        WHERE operacion = ?
    `);

    const rows = [];
    $('tbody tr').each((i, tr) => {
        const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
        if (cols.length >= 10) {
            rows.push({
                operacion: cols[0],
                nombre: cols[1],
                seccion: cols[2],
                patente: cols[3],
                vehiculo: cols[4],
                telefono: cols[5],
                sumaAseg: cols[6],
                codProd: cols[7],
                cuenta: cols[8],
                finVig: cols[9],
                renovada: cols[10] || '',
                cuoDebe: parseInt(cols[11]) || 0
            });
        }
    });

    const transaction = db.transaction((items) => {
        for (const item of items) {
            if (!item.operacion) continue;

            const finVig = parseFechaArg(item.finVig);
            let estado = 'vigente';
            const renStr = String(item.renovada || '').toLowerCase();
            if (renStr.includes('anulad')) {
                estado = 'anulada';
            } else if (renStr.includes('baja')) {
                estado = 'baja';
            } else if (finVig) {
                const hoy = new Date();
                const venc = new Date(finVig);
                if (venc < hoy) estado = 'vencida';
                else if ((venc - hoy) / 86400000 <= 30) estado = 'por_vencer';
            }

            // Detect vehicle type
            let tipoVehiculo = 'Auto';
            const v = (item.vehiculo || '').toUpperCase();
            if (/\b(MOTO|MOTOS|MOTOCICLETA|CUATRICICLO|ZANELLA|TITAN|TORNADO|TWISTER|WAVE|BIZ|YBR|HONDA CG)\b/.test(v)) tipoVehiculo = 'Moto';
            else if (/\b(PICK|PICKUP|HILUX|RANGER|AMAROK|L200|S10|FRONTIER|STRADA|SAVEIRO|TORO|FIORINO|KANGOO|PARTNER|BERLINGO)\b/.test(v)) tipoVehiculo = 'Pick Up';
            else if (/\b(CAMION|CAMIÓN|SCANIA|IVECO|VOLVO|ACOPLADO|SEMI|TRAILER|CARGO|1114|1215|608|7000)\b/.test(v)) tipoVehiculo = 'Camión';

            let cliente_id;
            const existing = findClienteByName.get(item.nombre);
            if (existing) {
                cliente_id = existing.id;
                const sanitized = sanitizeAndFixPhone(item.telefono);
                if (sanitized && !item.telefono.includes('9902073')) {
                    updateClienteTel.run(sanitized, cliente_id);
                    if (typeof db.guardarTelefonoMaestro === 'function') {
                        db.guardarTelefonoMaestro(cliente_id, item.nombre, sanitized, 'nre');
                    }
                }
            } else {
                const sanitized = (!item.telefono || item.telefono.includes('9902073')) ? '' : sanitizeAndFixPhone(item.telefono);
                const info = insertCliente.run(item.nombre, sanitized);
                cliente_id = info.lastInsertRowid;
                if (sanitized && typeof db.guardarTelefonoMaestro === 'function') {
                    db.guardarTelefonoMaestro(cliente_id, item.nombre, sanitized, 'nre');
                }
            }

            const existingPoliza = findPoliza.get(item.operacion);
            if (existingPoliza) {
                updatePoliza.run(item.seccion, tipoVehiculo, item.patente, item.vehiculo, item.sumaAseg, finVig, item.renovada, item.cuoDebe, estado, item.operacion);
                actualizados++;
            } else {
                // Shield main active portfolio: Only insert new active/vigente policies into polizas. Old historical records go to polizas_historicas!
                const hoy = new Date();
                const venc = finVig ? new Date(finVig) : null;
                if (venc && venc >= hoy) {
                    insertPoliza.run(cliente_id, item.operacion, item.seccion, tipoVehiculo, item.patente, item.vehiculo, item.sumaAseg, item.codProd, item.cuenta, finVig, finVig, item.renovada, item.cuoDebe, estado);
                    importados++;
                } else {
                    db.prepare(`
                        INSERT OR IGNORE INTO polizas_historicas (nombre, telefono, operacion, seccion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, estrategia)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '🎯 Oportunidad Reactivación')
                    `).run(item.nombre, item.telefono || '', item.operacion, item.seccion, tipoVehiculo, item.patente, item.vehiculo, finVig);
                }
            }
        }
    });

    transaction(rows);
    if (typeof db.restaurarTelefonosMaestros === 'function') {
        db.restaurarTelefonosMaestros();
    }
    return { importados, actualizados, total: rows.length };
}

/**
 * Trae Deudas desde lisdeupmo.php (Deuda Asegurados)
 */
async function syncDeudasNRE(usuario, password, desdeStr, hastaStr) {
    const curYear = new Date().getFullYear();
    desdeStr = desdeStr || `01/01/${curYear}`;
    hastaStr = hastaStr || `31/12/${curYear}`;
    const { baseUrl, getCookieString } = await loginNRE(usuario, password);

    const params = new URLSearchParams();
    params.append('produ', "('9902073')");
    params.append('desde', desdeStr);
    params.append('hasta', hastaStr);

    const res = await fetchWithRetry(`${baseUrl}/lisdeupmo.php`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': getCookieString()
        },
        body: params.toString()
    });

    const data = await res.json();
    if (!data.tabla) return { actualizados: 0, error: 'No se encontraron deudas' };

    const $ = cheerio.load(data.tabla);
    let actualizados = 0;
    const d = new Date();
    const hoyStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Detectar dinámicamente el índice de columna para "Saldo Cli" del header de la tabla.
    // NUNCA usar Saldo Broker — solo importa la deuda del cliente, no la del intermediario.
    let colIdxOperacion = 1;
    let colIdxNroCuota = 6;
    let colIdxVtoCuota = 7;
    let colIdxSaldoCli = 9; // fallback por si no se detecta header
    const headerCols = $('thead tr th, thead tr td').map((j, th) => $(th).text().trim().toLowerCase()).get();
    if (headerCols.length > 0) {
        const iOp = headerCols.findIndex(h => h.includes('oper'));
        if (iOp >= 0) colIdxOperacion = iOp;
        const iNro = headerCols.findIndex(h => h === 'nro' || h === 'nro cuota' || h === 'n°cuota' || h.includes('cuota') && !h.includes('vto'));
        if (iNro >= 0) colIdxNroCuota = iNro;
        const iVto = headerCols.findIndex(h => h.includes('vto') || h.includes('vencim'));
        if (iVto >= 0) colIdxVtoCuota = iVto;
        // 🔑 Buscar "Saldo Cli" explícitamente — ignorar "Saldo Broker"
        const iSaldoCli = headerCols.findIndex(h => h.includes('saldo') && h.includes('cli'));
        if (iSaldoCli >= 0) colIdxSaldoCli = iSaldoCli;
    }
    console.log(`[syncDeudasNRE] Headers detectados: op=${colIdxOperacion} nrocuota=${colIdxNroCuota} vto=${colIdxVtoCuota} saldoCli=${colIdxSaldoCli}`);

    // Group cuotas count, first unpaid vtoCuota, saldoCli, and full cuotas history per operacion
    const deudasPorOp = {};
    $('tbody tr').each((i, tr) => {
        const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
        if (cols.length >= 8) {
            const nroCuotaStr = cols[colIdxNroCuota] || '1';
            const operacion = cols[colIdxOperacion];
            const saldoCliText = cols[colIdxSaldoCli] || '0';
            const cleanSaldo = saldoCliText.replace(/[^0-9,-]/g, '').replace(',', '.');
            const saldoCli = parseFloat(cleanSaldo) || 0;
            const vtoCuota = parseFechaArg(cols[colIdxVtoCuota]);
            const fechaPago = null;
            const lote = '';

            if (operacion) {
                if (!deudasPorOp[operacion]) {
                    deudasPorOp[operacion] = {
                        cantDebe: 0,
                        primeraCuota: null,
                        vtoPrimeraCuota: null,
                        totalSaldo: 0,
                        historial: []
                    };
                }

                const nroInt = parseInt(nroCuotaStr) || 1;
                const estaPendiente = saldoCli > 0;

                if (estaPendiente && vtoCuota) {
                    deudasPorOp[operacion].totalSaldo += saldoCli;
                    if (vtoCuota < hoyStr) {
                        deudasPorOp[operacion].cantDebe += 1;
                    }
                    if (!deudasPorOp[operacion].vtoPrimeraCuota || nroInt < deudasPorOp[operacion].primeraCuota) {
                        deudasPorOp[operacion].vtoPrimeraCuota = vtoCuota;
                        deudasPorOp[operacion].primeraCuota = nroInt;
                    }
                }

                deudasPorOp[operacion].historial.push({
                    nro_cuota: nroInt,
                    vto_cuota: vtoCuota,
                    saldo_cli: saldoCli,
                    estado: estaPendiente ? 'PENDIENTE' : 'PAGADA',
                    fecha_pago: fechaPago,
                    lote: lote
                });
            }
        }
    });

    const resetCuotas = db.prepare('UPDATE polizas SET cuotas_debe = 0, saldo_pendiente = 0');
    const updatePolizaDeuda = db.prepare(`
        UPDATE polizas 
        SET cuotas_debe = ?, 
            nro_cuota = COALESCE(?, nro_cuota), 
            saldo_pendiente = ?, 
            fecha_vencimiento = COALESCE(?, fecha_vencimiento), 
            cuotas_historial = ? 
        WHERE operacion = ? 
          AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja')
          AND NOT EXISTS (
              SELECT 1 FROM polizas p2 
              WHERE UPPER(TRIM(p2.patente)) = UPPER(TRIM(polizas.patente))
                AND p2.id != polizas.id 
                AND CAST(p2.operacion AS INTEGER) > CAST(polizas.operacion AS INTEGER)
          )
    `);

    db.transaction((map) => {
        resetCuotas.run();
        for (const [op, infoData] of Object.entries(map)) {
            const historialJson = JSON.stringify(infoData.historial);
            const info = updatePolizaDeuda.run(
                infoData.cantDebe,
                infoData.primeraCuota,
                infoData.totalSaldo,
                infoData.vtoPrimeraCuota,
                historialJson,
                op
            );
            if (info.changes > 0) actualizados++;
        }
    })(deudasPorOp);

    if (typeof db.restaurarTelefonosMaestros === 'function') {
        db.restaurarTelefonosMaestros();
    }
    if (typeof db.sincronizarSaldosCuotasHistorial === 'function') {
        db.sincronizarSaldosCuotasHistorial();
    }
    if (typeof db.evaluarAtribucionMetricas === 'function') {
        db.evaluarAtribucionMetricas();
    }

    // ⚡ CRITICAL: Solo incluir en opsEnDeudaSet las que tienen saldo REAL > 0.
    // Si NRE lista una póliza pero su Saldo Cli = $0 (pagada por cliente, broker aún no acreditó),
    // NO debe excluirse de la verificación individual de syncPagosNRE.
    const opsConDeudaReal = new Set(
        Object.entries(deudasPorOp)
            .filter(([op, info]) => info.totalSaldo > 0)
            .map(([op]) => op)
    );

    return { actualizados, deudores_totales: Object.keys(deudasPorOp).length, opsEnDeudaSet: opsConDeudaReal };
}

/**
 * Verifica pólizas con deuda contra la pestaña Pagos/Cuotas de muestro-polizas.php.
 * Si NRE muestra Saldo Cli = $0 en TODAS las cuotas → la póliza está saldada.
 * Solo consulta pólizas que figuren con saldo_pendiente > 0 O cuotas_debe > 0 en la DB.
 */
async function syncPagosNRE(usuario = 'SUA', password = 'sua', opsEnNreDeuda = null) {
    const { baseUrl, getCookieString } = await loginNRE(usuario, password);

    // Consultar pólizas con saldo pendiente registradas en la DB
    const deudoresDb = db.prepare("SELECT operacion, saldo_pendiente, cuotas_debe FROM polizas WHERE saldo_pendiente > 0").all();

    // Filtrar candidatos inteligentes: pólizas que figuran con deuda en DB pero NRE ya NO las incluye en su lista de deudas con saldo real
    let candidatos = deudoresDb;
    if (opsEnNreDeuda && opsEnNreDeuda instanceof Set && opsEnNreDeuda.size > 0) {
        candidatos = deudoresDb.filter(p => !opsEnNreDeuda.has(p.operacion));
    }
    // Limitar a 60 candidatos por sync para no saturar NRE ni demorar demasiado el botón
    const MAX_CANDIDATOS = 60;
    if (candidatos.length > MAX_CANDIDATOS) {
        console.log(`[syncPagosNRE] Limitando verificación a ${MAX_CANDIDATOS} de ${candidatos.length} candidatos`);
        candidatos = candidatos.slice(0, MAX_CANDIDATOS);
    }
    console.log(`[syncPagosNRE] Verificando ${candidatos.length} pólizas candidatas...`);

    let saldadas = 0;
    const actualizarSaldada = db.prepare(`
        UPDATE polizas 
        SET cuotas_debe = 0, saldo_pendiente = 0, cuotas_historial = ?
        WHERE operacion = ?
    `);

    const cheerio = require('cheerio');

    // Procesar en lotes de 5 para no saturar NRE (antes era ilimitado y tardaba mucho)
    const CONCURRENCIA = 5;
    const chunks = [];
    for (let i = 0; i < candidatos.length; i += CONCURRENCIA) {
        chunks.push(candidatos.slice(i, i + CONCURRENCIA));
    }
    for (const chunk of chunks) {
    await Promise.all(chunk.map(async (pol) => {
        try {
            const res = await fetchWithRetry(`${baseUrl}/muestro-polizas.php?&prop=${pol.operacion}`, {
                headers: { 'Cookie': getCookieString() },
                signal: AbortSignal.timeout(4000)
            });
            if (!res.ok) return;
            const html = await res.text();
            const $ = cheerio.load(html);

            let cuotasSaldoCli = [];
            let historialActualizado = [];

            $('table').each((i, t) => {
                const headers = $(t).find('th').map((j, h) => $(h).text().trim()).get();
                if (headers.includes('Saldo Cli') && headers.includes('Cuota')) {
                    $(t).find('tbody tr').each((i, tr) => {
                        const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
                        if (cols.length >= 4) {
                            const nroCuota = parseInt(cols[0]) || (i + 1);
                            const vtoCuota = parseFechaArg(cols[1]) || '';
                            const saldoCliText = cols[3] || '0';
                            const saldoCli = parseFloat(saldoCliText.replace(/[^0-9,-]/g, '').replace(',', '.')) || 0;
                            cuotasSaldoCli.push(saldoCli);
                            historialActualizado.push({
                                nro_cuota: nroCuota,
                                vto_cuota: vtoCuota,
                                saldo_cli: saldoCli,
                                estado: saldoCli === 0 ? 'PAGADA' : 'PENDIENTE',
                                fecha_pago: null,
                                lote: ''
                            });
                        }
                    });
                }
            });

            if (cuotasSaldoCli.length > 0 && cuotasSaldoCli.every(s => s === 0)) {
                actualizarSaldada.run(JSON.stringify(historialActualizado), pol.operacion);
                saldadas++;
            }
        } catch (e) {
            // Ignore timeouts / NRE errors
        }
    }));
    } // fin chunks loop

    console.log(`[syncPagosNRE] Completado: ${saldadas} pólizas saldadas de ${candidatos.length} verificadas`);
    return { verificadas: candidatos.length, saldadas };
}

/**
 * Sincroniza y verifica pólizas Anuladas / dadas de Baja contra traigo-polizas.php
 */
async function syncAnuladasNRE(usuario = 'SUA', password = 'sua') {
    const cheerio = require('cheerio');
    let anuladasEncontradas = 0;
    try {
        const { baseUrl, getCookieString } = await loginNRE(usuario, password);
        const rowsPat = db.prepare(`
            SELECT DISTINCT patente 
            FROM polizas 
            WHERE patente IS NOT NULL AND patente != '' 
              AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja')
        `).all();

        const markAnulada = db.prepare(`
            UPDATE polizas 
            SET estado = 'anulada', cuotas_debe = 0, saldo_pendiente = 0 
            WHERE operacion = ?
        `);

        const batchSize = 10;
        for (let i = 0; i < rowsPat.length; i += batchSize) {
            const chunk = rowsPat.slice(i, i + batchSize);
            await Promise.all(chunk.map(async (rowPat) => {
                try {
                    const formParams = new URLSearchParams();
                    formParams.append('poli', '');
                    formParams.append('endo', '0');
                    formParams.append('prop', '');
                    formParams.append('patente', rowPat.patente);
                    formParams.append('asegurado', '');
                    formParams.append('sini', '');

                    const res = await fetchWithRetry(`${baseUrl}/traigo-polizas.php`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Cookie': getCookieString(),
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        body: formParams.toString()
                    });

                    const json = await res.json();
                    if (json && json.tabla) {
                        const $ = cheerio.load(json.tabla);
                        $('tbody tr, tr').each((j, tr) => {
                            const cols = $(tr).find('td').map((k, td) => $(td).text().trim()).get();
                            if (cols.length >= 7) {
                                const op = cols[0];
                                const estadoStr = (cols[6] || '').toLowerCase();
                                if (op && (estadoStr.includes('anulad') || estadoStr.includes('baja'))) {
                                    const info = markAnulada.run(op);
                                    if (info.changes > 0) anuladasEncontradas++;
                                }
                            }
                        });
                    }
                } catch (err) {
                    // Ignore per-patente fetch error
                }
            }));
        }
    } catch (err) {
        console.error('Error en syncAnuladasNRE:', err);
    }
    return { anuladas_encontradas: anuladasEncontradas };
}

/**
 * Sincronización General en Vivo (4 en 1: Vencimientos, Deudas vencidas, Verificación de Pagos + Pólizas Anuladas)
 */
async function syncGeneralNRE(usuario = 'SUA', password = 'sua') {
    const currentYear = new Date().getFullYear();
    // 1. Sync Vencimientos
    const vtoRes = await syncVencimientosNRE(usuario, password, `01/01/${currentYear}`, `31/12/${currentYear}`);

    // 2. Sync Deudas Real NRE
    const deudasRes = await syncDeudasNRE(usuario, password, `01/01/${currentYear}`, `31/12/${currentYear}`);

    // 3. ⚡ Verificar Pagos instantáneamente solo para candidatos (pólizas que NRE ya no reporta como deudoras)
    const opsEnDeuda = deudasRes.opsEnDeudaSet || null;
    const pagosRes = await syncPagosNRE(usuario, password, opsEnDeuda);

    // 4. 🚫 Sincronizar Pólizas Anuladas / dadas de Baja en NRE
    const anuladasRes = await syncAnuladasNRE(usuario, password);

    if (typeof db.restaurarTelefonosMaestros === 'function') {
        db.restaurarTelefonosMaestros();
    }
    if (typeof db.evaluarAtribucionMetricas === 'function') {
        db.evaluarAtribucionMetricas();
    }

    return {
        vencimientos_sincronizados: vtoRes.total || 0,
        deudores_vencidos: deudasRes.actualizados || 0,
        polizas_saldadas_verificadas: pagosRes.saldadas || 0,
        polizas_verificadas_pagos: pagosRes.verificadas || 0,
        polizas_anuladas_detectadas: anuladasRes.anuladas_encontradas || 0
    };
}

/**
 * Evalúa el estado de pago de una póliza bajo las Reglas 1 a 9.
 * Regla 1: Fecha de vencimiento NO es prueba de mora.
 * Regla 2: Saldo Cli = $0 -> Saldada (independientemente del vencimiento).
 * Regla 3: Cruce con Recibos de Pagos.
 * Regla 4: Saldo Broker IGNORED (no es deuda del cliente).
 * Regla 5: Verificación Triple (Vencimiento + Saldo Cli + Pagos).
 * Regla 6: Priorizar Saldo Cli ante ambigüedades.
 * Regla 7: Pagos Adelantados por Importe Total.
 * Regla 8: Pago Total Anticipado en Motos.
 * Regla 9: Importe Pagado > Fecha de Vencimiento.
 */
function calcularDeudaRealConReglas(tipoVehiculo, totalPagado, cuotasArray, hoyStr) {
    const isMoto = (tipoVehiculo || '').toUpperCase() === 'MOTO';
    const totalPrimaPoliza = cuotasArray.reduce((acc, c) => acc + (c.importe || 0), 0);

    // Regla 8: Caso Especial MOTOS (pago total anticipado)
    if (isMoto && totalPagado > 0 && (totalPagado >= totalPrimaPoliza * 0.95 || totalPrimaPoliza === 0)) {
        return 0; // Póliza totalmente saldada
    }

    // Regla 3: Si la suma de recibos cubre el total de cuotas emitidas -> Saldado
    if (totalPagado > 0 && totalPagado >= totalPrimaPoliza && totalPrimaPoliza > 0) {
        return 0;
    }

    let cuotasImpagasReales = 0;
    let saldoRemanente = totalPagado;

    for (const c of cuotasArray) {
        const saldoCli = c.saldo_cli !== undefined ? c.saldo_cli : (c.saldo !== undefined ? c.saldo : null);

        // Regla 2 & 6: Si Saldo Cli es 0 -> la cuota está saldada por el cliente
        if (saldoCli === 0) {
            continue;
        }

        // Regla 1 & 9: Si la fecha venció pero el saldo de pagos lo cubre -> saldada
        if (c.vencimiento <= hoyStr) {
            if (saldoRemanente >= (c.importe || 0)) {
                saldoRemanente -= (c.importe || 0);
            } else {
                cuotasImpagasReales++;
            }
        }
    }

    return cuotasImpagasReales;
}

module.exports = { syncVencimientosNRE, syncDeudasNRE, syncGeneralNRE, syncPagosNRE, syncAnuladasNRE, calcularDeudaRealConReglas };
