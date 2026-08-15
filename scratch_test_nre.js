const cheerio = require('cheerio');
const db = require('./database');

async function testNRE() {
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

    console.log('Logged in successfully to NRE!');

    // Test 1: Search TOT405 in traigo-polizas.php
    const p2 = new URLSearchParams();
    p2.append('poli', '');
    p2.append('endo', '0');
    p2.append('prop', '');
    p2.append('patente', 'TOT405');
    p2.append('asegurado', '');
    p2.append('sini', '');
    const r2 = await fetch(baseUrl + '/traigo-polizas.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieString(), 'X-Requested-With': 'XMLHttpRequest' },
        body: p2.toString()
    });
    const d2 = await r2.json();
    console.log('TOT405 en traigo-polizas.php:');
    if (d2.tabla) {
        const $2 = cheerio.load(d2.tabla);
        $2('tr').each((i, tr) => {
            const cols = $2(tr).find('td').map((j, td) => $2(td).text().trim()).get();
            if (cols.length > 0) console.log('  Row:', cols);
        });
    }

    // Test 2: Check muestro-polizas.php for TOT405 operations (11835640 vs 11995328)
    for (const op of ['11835640', '11995328']) {
        const r3 = await fetch(baseUrl + '/muestro-polizas.php?prop=' + op, {
            headers: { 'Cookie': getCookieString() }
        });
        const html = await r3.text();
        const $3 = cheerio.load(html);
        console.log('=== Detalle Op ' + op + ' en muestro-polizas ===');
        $3('tr').each((i, tr) => {
            const rowText = $3(tr).text().replace(/\s+/g, ' ').trim();
            if (rowText.includes('Cuota') || rowText.includes('Saldo') || rowText.includes('Vigencia') || rowText.includes('Aseg') || rowText.includes('13/')) {
                console.log('  ' + rowText);
            }
        });
    }
}

testNRE().catch(console.error);
