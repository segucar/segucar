const cheerio = require('cheerio');

async function checkDeudasNRE() {
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

    const ops = ['11906627', '11908896', '11907911', '11909086', '11908511', '11906564', '11908565'];
    for (const op of ops) {
        const r = await fetch(baseUrl + '/muestro-polizas.php?prop=' + op, {
            headers: { 'Cookie': getCookieString() }
        });
        const html = await r.text();
        const $ = cheerio.load(html);
        console.log('=== Op ' + op + ' en NRE muestro-polizas ===');
        $('table tr').each((i, tr) => {
            const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
            if (cols.length >= 4) {
                console.log('  Cuota:', cols[0], '| Venc:', cols[1], '| Importe:', cols[2], '| SaldoCli:', cols[3]);
            }
        });
    }
}

checkDeudasNRE().catch(console.error);
