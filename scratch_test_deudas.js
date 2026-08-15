const cheerio = require('cheerio');

async function testDeudas() {
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

    const curYear = new Date().getFullYear();
    const params = new URLSearchParams();
    params.append('produ', "('9902073')");
    params.append('desde', '01/01/' + (curYear - 1));
    params.append('hasta', '31/12/' + (curYear + 1));

    const res = await fetch(baseUrl + '/lisdeupmo.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': getCookieString() },
        body: params.toString()
    });

    const data = await res.json();
    if (!data.tabla) {
        console.log('No tabla in lisdeupmo');
        return;
    }

    const $ = cheerio.load(data.tabla);
    console.log('Total rows in lisdeupmo:', $('tbody tr').length);

    $('tbody tr').each((i, tr) => {
        const text = $(tr).text();
        if (text.includes('TOT405') || text.includes('11995328') || text.includes('11835640') || text.includes('LOR311') || text.includes('11996611')) {
            const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
            console.log('Match in lisdeupmo:', cols);
        }
    });
}

testDeudas().catch(console.error);
