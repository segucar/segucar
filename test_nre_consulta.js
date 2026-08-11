const cheerio = require('cheerio');
const db = require('./database');

async function testSyncAnuladas() {
    const baseUrl = 'http://149.50.137.101/emision';
    const loginParams = new URLSearchParams();
    loginParams.append('useremi', 'SUA');
    loginParams.append('pasemi', 'sua');
    const loginRes = await fetch(`${baseUrl}/emivali.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginParams.toString(),
        redirect: 'manual'
    });
    const cookies = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');

    // Get all active patentes from DB
    const rowsPat = db.prepare(`
        SELECT DISTINCT patente 
        FROM polizas 
        WHERE patente IS NOT NULL AND patente != '' 
          AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja')
    `).all();

    console.log(`Verificando estado de ${rowsPat.length} patentes activas...`);

    const markAnulada = db.prepare(`
        UPDATE polizas 
        SET estado = 'anulada', cuotas_debe = 0, saldo_pendiente = 0 
        WHERE operacion = ?
    `);

    let anuladasEncontradas = 0;

    // Concurrencia de 5 peticiones
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

                const res = await fetch(`${baseUrl}/traigo-polizas.php`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Cookie': cookies,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: formParams.toString()
                });

                const json = await res.json();
                if (json.tabla) {
                    const $ = cheerio.load(json.tabla);
                    $('tbody tr, tr').each((j, tr) => {
                        const cols = $(tr).find('td').map((k, td) => $(td).text().trim()).get();
                        if (cols.length >= 7) {
                            const op = cols[0];
                            const estadoStr = (cols[6] || '').toLowerCase();
                            if (op && (estadoStr.includes('anulad') || estadoStr.includes('baja'))) {
                                const info = markAnulada.run(op);
                                if (info.changes > 0) {
                                    anuladasEncontradas++;
                                    console.log(`  🚫 Póliza anulada/baja detectada y marcada: Op=${op}, Patente=${cols[3]}, Asegurado=${cols[1]}, Estado="${cols[6]}"`);
                                }
                            }
                        }
                    });
                }
            } catch (err) {
                // Ignore per-patente fetch errors
            }
        }));
    }

    console.log(`✅ Finalizado. Pólizas anuladas/baja actualizadas: ${anuladasEncontradas}`);
}

testSyncAnuladas().catch(console.error);
