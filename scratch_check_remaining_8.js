const cheerio = require('cheerio');

async function checkRemaining8() {
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

    const ops = ['11908896', '11948021', '12007617', '11911713', '11908998', '12007518', '11911742', '11908942'];
    for (const op of ops) {
        const res = await fetch(baseUrl + '/muestro-polizas.php?prop=' + op, {
            headers: { 'Cookie': getCookieString() }
        });
        const html = await res.text();
        const $ = cheerio.load(html);

        let saldoCli = 0;
        let info = [];
        $('table').each((i, t) => {
            const headers = $(t).find('th').map((j, h) => $(h).text().trim()).get();
            if (headers.includes('Saldo Cli') && headers.includes('Cuota')) {
                $(t).find('tbody tr').each((j, tr) => {
                    const cols = $(tr).find('td').map((k, td) => $(td).text().trim()).get();
                    if (cols.length >= 4) {
                        const nro = parseInt(cols[0]);
                        const vto = cols[1];
                        const s = parseFloat((cols[3] || '$ 0').replace(/[^0-9,-]/g, '').replace(',', '.')) || 0;
                        info.push(`Cuota ${nro} (${vto}): SaldoCli ${s}`);
                        saldoCli += s;
                    }
                });
            }
        });
        console.log(`Op: ${op} | Saldo Total Cli: $${saldoCli} | Detalle:`, info.join(' | '));
    }
}

checkRemaining8().catch(console.error);
