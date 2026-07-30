const cheerio = require('cheerio');

async function loginNRE(usuario = 'SUA', password = 'sua') {
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

    try {
        const loginPageRes = await fetch(`${baseUrl}/index.php`);
        updateCookies(loginPageRes);
        
        const loginParams = new URLSearchParams();
        loginParams.append('useremi', usuario);
        loginParams.append('pasemi', password);

        const loginRes = await fetch(`${baseUrl}/emivali.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': getCookieString()
            },
            body: loginParams.toString(),
            redirect: 'manual'
        });
        updateCookies(loginRes);
        return getCookieString();
    } catch (e) {
        console.error("Login failed:", e);
        return null;
    }
}

async function fetchObservationsNRE(operacion, cookieStr) {
    const baseUrl = 'http://149.50.137.101/emision';
    try {
        const detailRes = await fetch(`${baseUrl}/muestro-polizas.php?prop=${operacion}`, {
            headers: { 'Cookie': cookieStr }
        });
        const detailText = await detailRes.text();
        const $ = cheerio.load(detailText);

        let observaciones = '';
        $('div[class*="col-md"]').each((idx, el) => {
            const text = $(el).text().trim().toLowerCase();
            if (text.includes('observacion')) {
                $(el).nextAll('div').each((sidx, sib) => {
                    if (sidx < 3) observaciones += ' ' + $(sib).text().trim();
                });
            }
        });
        return observaciones.trim();
    } catch (e) {
        return '';
    }
}

async function main() {
    const cookie = await loginNRE();
    if (!cookie) return;
    
    console.log("Fetching Renault R 19 (11859812)...");
    const obs1 = await fetchObservationsNRE('11859812', cookie);
    console.log("Observations 1:", obs1);
    
    console.log("Fetching VW Saveiro (11918939)...");
    const obs2 = await fetchObservationsNRE('11918939', cookie);
    console.log("Observations 2:", obs2);
}

main();
