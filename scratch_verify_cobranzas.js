const cheerio = require('cheerio');
const db = require('./database');

async function testSyncAllCobranzas() {
    const baseUrl = 'http://149.50.137.101/emision';
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

    const loginPageRes = await fetch(baseUrl + '/index.php');
    updateCookies(loginPageRes);

    const loginParams = new URLSearchParams();
    loginParams.append('useremi', 'SUA');
    loginParams.append('pasemi', 'sua');

    const loginRes = await fetch(baseUrl + '/emivali.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieString() },
        body: loginParams.toString(),
        redirect: 'manual'
    });
    updateCookies(loginRes);

    // Traer todas las pólizas con fecha de vencimiento entre 15/08/2026 y 25/08/2026 con saldo > 0
    const deudores = db.prepare("SELECT operacion, patente, saldo_pendiente, fecha_vencimiento FROM polizas WHERE saldo_pendiente > 0 AND fecha_vencimiento >= '2026-08-15' AND fecha_vencimiento <= '2026-08-25'").all();
    console.log('Total polizas a verificar en ventana de cobranza:', deudores.length);

    let saldadasCount = 0;
    const batchSize = 10;
    for (let i = 0; i < deudores.length; i += batchSize) {
        const chunk = deudores.slice(i, i + batchSize);
        await Promise.all(chunk.map(async (d) => {
            try {
                const res = await fetch(baseUrl + '/muestro-polizas.php?prop=' + d.operacion, {
                    headers: { 'Cookie': getCookieString() }
                });
                const html = await res.text();
                const $ = cheerio.load(html);

                let cuotasHistorial = [];
                let totalSaldoCli = 0;
                let todasSaldadas = true;
                let hayCuotas = false;

                $('table').each((i, t) => {
                    const headers = $(t).find('th').map((j, h) => $(h).text().trim()).get();
                    if (headers.includes('Saldo Cli') && headers.includes('Cuota')) {
                        $(t).find('tbody tr').each((j, tr) => {
                            const cols = $(tr).find('td').map((k, td) => $(td).text().trim()).get();
                            if (cols.length >= 4) {
                                const nro = parseInt(cols[0]);
                                const vto = cols[1];
                                const saldoCliText = cols[3] || '$ 0,00';
                                const saldoCli = parseFloat(saldoCliText.replace(/[^0-9,-]/g, '').replace(',', '.')) || 0;

                                if (!isNaN(nro) && nro > 0) {
                                    hayCuotas = true;
                                    totalSaldoCli += saldoCli;
                                    if (saldoCli > 0) todasSaldadas = false;
                                    cuotasHistorial.push({
                                        nro_cuota: nro,
                                        vto_cuota: vto,
                                        saldo_cli: saldoCli,
                                        estado: saldoCli === 0 ? 'PAGADA' : 'PENDIENTE'
                                    });
                                }
                            }
                        });
                    }
                });

                if (hayCuotas) {
                    if (todasSaldadas || totalSaldoCli === 0) {
                        console.log('  ✅ PÓLIZA SALDADA POR CLIENTE: Op', d.operacion, '| Pat:', d.patente, '| FV:', d.fecha_vencimiento, '| Saldo previo:', d.saldo_pendiente);
                        saldadasCount++;
                        db.prepare('UPDATE polizas SET saldo_pendiente = 0, cuotas_debe = 0, cuotas_historial = ? WHERE operacion = ?').run(JSON.stringify(cuotasHistorial), d.operacion);
                    } else if (Math.abs(totalSaldoCli - d.saldo_pendiente) > 1) {
                        console.log('  🔄 ACTUALIZANDO SALDO PARCIAL: Op', d.operacion, '| Saldo previo:', d.saldo_pendiente, '-> Saldo real:', totalSaldoCli);
                        db.prepare('UPDATE polizas SET saldo_pendiente = ?, cuotas_historial = ? WHERE operacion = ?').run(totalSaldoCli, JSON.stringify(cuotasHistorial), d.operacion);
                    }
                }
            } catch (e) {
                // Ignore
            }
        }));
    }

    console.log('Total de pólizas saldadas detectadas y corregidas:', saldadasCount);
}

testSyncAllCobranzas().catch(console.error);
