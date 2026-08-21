const cheerio = require('cheerio');

async function testMuestroPolizasHeader() {
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

    const res = await fetch(baseUrl + '/muestro-polizas.php?&prop=11907911', {
        headers: { 'Cookie': getCookieString() }
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    console.log('--- TEST LOGICA ACTUAL DE syncPagosNRE ---');
    let matchedTables = 0;
    $('table').each((i, t) => {
        const headers = $(t).find('th').map((j, h) => $(h).text().trim()).get();
        console.log('Table', i, 'TH count:', headers.length, headers);
        if (headers.includes('Saldo Cli') && headers.includes('Cuota')) {
            matchedTables++;
        }
    });
    console.log('Matched tables with TH:', matchedTables);

    console.log('--- BUSCANDO POR TR (TD o TH) ---');
    $('table tr').each((i, tr) => {
        const cells = $(tr).find('td, th').map((j, td) => $(td).text().trim()).get();
        if (cells.some(c => c.includes('Saldo Cli'))) {
            console.log('Found Header Row:', cells);
        }
        if (cells.length >= 4 && /^\d+$/.test(cells[0])) {
            console.log('Found Cuota Row:', cells);
        }
    });
}

testMuestroPolizasHeader().catch(console.error);
