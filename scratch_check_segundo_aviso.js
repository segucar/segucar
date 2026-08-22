const cheerio = require('cheerio');

async function checkSegundoAviso() {
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

    const ops = [
        '12015621', // Bertolot
        '11960260', // Alegria
        '11959436', // Bobadilla
        '11907135', // Bravo
        '11906677', // Gari
        '12019250', // Gayoso
        '11959507', // Mendez
        '11907139'  // Romero
    ];

    for (const op of ops) {
        const res = await fetch(baseUrl + '/muestro-polizas.php?prop=' + op, {
            headers: { 'Cookie': getCookieString() }
        });
        const html = await res.text();
        const $ = cheerio.load(html);

        console.log('=== Op ' + op + ' ===');
        // Check Pagos tab
        $('table').each((i, t) => {
            const headers = $(t).find('th').map((j, h) => $(h).text().trim()).get();
            if (headers.includes('Recibo') || headers.includes('Importe') && headers.includes('Fecha')) {
                $(t).find('tbody tr').each((j, tr) => {
                    const cols = $(tr).find('td').map((k, td) => $(td).text().trim()).get();
                    if (cols.length >= 3) console.log('  Pago registrado:', cols.join(' | '));
                });
            }
            if (headers.includes('Saldo Cli') && headers.includes('Cuota')) {
                $(t).find('tbody tr').each((j, tr) => {
                    const cols = $(tr).find('td').map((k, td) => $(td).text().trim()).get();
                    if (cols.length >= 4) {
                        console.log(`  Cuota ${cols[0]} (${cols[1]}): Imp=${cols[2]} SaldoCli=${cols[3]} ImpBroker=${cols[4]} SaldoBroker=${cols[5]}`);
                    }
                });
            }
        });
    }
}

checkSegundoAviso().catch(console.error);
