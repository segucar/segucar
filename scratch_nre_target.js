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
        return { baseUrl, getCookieString };
    } catch (e) {
        console.error("Login failed:", e);
        return null;
    }
}

async function searchOperationNRE(op, conn) {
    const params = new URLSearchParams();
    params.append('produ', "('9902073')");
    params.append('desde', '01/01/2026');
    params.append('hasta', '31/12/2026');
    params.append('seccio', '0');
    params.append('operac', op);
    params.append('patente', '');
    params.append('asegura', '');

    try {
        const res = await fetch(`${conn.baseUrl}/lisvtopol.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': conn.getCookieString()
            },
            body: params.toString()
        });
        const data = await res.json();
        if (!data.tabla) return null;

        const $ = cheerio.load(data.tabla);
        let matchedRow = null;
        $('tbody tr').each((i, tr) => {
            const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
            if (cols.length >= 10 && cols[0] === op) {
                matchedRow = cols;
            }
        });
        return matchedRow;
    } catch (e) {
        console.error(`Search for ${op} failed:`, e);
        return null;
    }
}

async function main() {
    const conn = await loginNRE();
    if (!conn) return;

    console.log("Searching NRE for operation 11859812...");
    const row1 = await searchOperationNRE('11859812', conn);
    console.log("Row 11859812:", row1);

    console.log("Searching NRE for operation 11918939...");
    const row2 = await searchOperationNRE('11918939', conn);
    console.log("Row 11918939:", row2);
}

main();
