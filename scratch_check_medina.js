const cheerio = require('cheerio');

async function checkNRE() {
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

    // Buscar A048RHL y KWS089 en traigo-polizas.php
    for (const pat of ['A048RHL', 'KWS089']) {
        const p = new URLSearchParams();
        p.append('poli', '');
        p.append('endo', '0');
        p.append('prop', '');
        p.append('patente', pat);
        p.append('asegurado', '');
        p.append('sini', '');
        const r = await fetch(baseUrl + '/traigo-polizas.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieString(), 'X-Requested-With': 'XMLHttpRequest' },
            body: p.toString()
        });
        const d = await r.json();
        console.log('=== Patente ' + pat + ' en traigo-polizas.php ===');
        if (d.tabla) {
            const $ = cheerio.load(d.tabla);
            $('tr').each((i, tr) => {
                const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
                if (cols.length > 0) console.log('  Row:', cols);
            });
        }
    }
}

checkNRE().catch(console.error);
