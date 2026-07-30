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

async function searchNRE(name, conn) {
    const params = new URLSearchParams();
    params.append('produ', "('9902073')");
    params.append('desde', '01/01/2026');
    params.append('hasta', '31/12/2026');
    params.append('seccio', '0');
    params.append('operac', '');
    params.append('patente', '');
    params.append('asegura', name);

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
        if (!data.tabla) return [];

        const $ = cheerio.load(data.tabla);
        const rows = [];
        $('tbody tr').each((i, tr) => {
            const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
            if (cols.length >= 10) {
                rows.push({
                    operacion: cols[0],
                    nombre: cols[1],
                    seccion: cols[2],
                    patente: cols[3],
                    vehiculo: cols[4],
                    telefono: cols[5],
                    finVig: cols[9]
                });
            }
        });
        return rows;
    } catch (e) {
        console.error("Search failed:", e);
        return [];
    }
}

async function fetchObservationsNRE(operacion, conn) {
    try {
        const detailRes = await fetch(`${conn.baseUrl}/muestro-polizas.php?prop=${operacion}`, {
            headers: { 'Cookie': conn.getCookieString() }
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
    const conn = await loginNRE();
    if (!conn) return;

    console.log("Searching NRE for MIQUEO...");
    const results = await searchNRE('MIQUEO', conn);
    console.log(`Found ${results.length} rows:`);
    for (const r of results) {
        console.log("---");
        console.log(`Op: ${r.operacion} | Name: ${r.nombre} | Patente: ${r.patente} | Phone standard: "${r.telefono}"`);
        const obs = await fetchObservationsNRE(r.operacion, conn);
        console.log(`Obs: "${obs}"`);
    }
}

main();
