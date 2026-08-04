const cheerio = require('cheerio');

async function fetchWithRetry(url, options = {}, maxRetries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, options);
            if (res.ok || res.status === 302) return res;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
            }
        } catch (err) {
            if (attempt === maxRetries) throw err;
            await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return fetch(url, options);
}

async function loginNRE(usuario = 'SUA', password = 'sua') {
    const baseUrl = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
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

    const loginPageRes = await fetchWithRetry(`${baseUrl}/index.php`);
    updateCookies(loginPageRes);

    const loginParams = new URLSearchParams();
    loginParams.append('useremi', usuario);
    loginParams.append('pasemi', password);

    const loginRes = await fetchWithRetry(`${baseUrl}/emivali.php`, {
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
}

async function checkNRE2026() {
  console.log('🔄 Conectando con NRE Emisión (http://149.50.137.101/emision)...');
  const { baseUrl, getCookieString } = await loginNRE('SUA', 'sua');
  console.log('✅ Login NRE OK. Obteniendo listado oficial de vencimientos 01/01/2026 a 31/12/2026...');

  const params = new URLSearchParams();
  params.append('produ', "('9902073')");
  params.append('desde', '01/01/2026');
  params.append('hasta', '31/12/2026');

  const res = await fetchWithRetry(`${baseUrl}/lisvtopol.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieString()
    },
    body: params.toString()
  });

  const data = await res.json();
  console.log('📦 Respuesta NRE recibida (Tabla HTML de NRE).');

  if (!data.tabla) {
    console.log('No se recibió tabla');
    return;
  }

  const $ = cheerio.load(data.tabla);
  const rows = [];
  $('tbody tr').each((i, tr) => {
    const cols = $(tr).find('td').map((j, td) => $(td).text().trim()).get();
    if (cols.length >= 6) {
      rows.push({
        operacion: cols[0],
        nombre: cols[1],
        seccion: cols[2],
        patente: cols[3],
        vehiculo: cols[4],
        telefono: cols[5],
        sumaAseg: cols[6],
        finVig: cols[9],
        renovada: cols[10],
        cuoDebe: cols[11]
      });
    }
  });

  console.log('\n📊 TOTAL REGISTROS OBTENIDOS EN VIVO DESDE NRE PARA TODO EL AÑO 2026:', rows.length);

  // Group by month of finVig in NRE
  const matrix = {};

  rows.forEach(r => {
    let mes = 'Sin fecha';
    if (r.finVig && r.finVig.includes('/')) {
      const parts = r.finVig.split('/');
      if (parts.length === 3) mes = `${parts[2]}-${parts[1].padStart(2, '0')}`;
    }

    let tipoVehiculo = 'Auto';
    const v = (r.vehiculo || '').toUpperCase();
    if (/\b(MOTO|MOTOS|MOTOCICLETA|CUATRICICLO|ZANELLA|TITAN|TORNADO|TWISTER|WAVE|BIZ|YBR|HONDA CG)\b/.test(v)) tipoVehiculo = 'Moto';
    else if (/\b(PICK|PICKUP|HILUX|RANGER|AMAROK|L200|S10|FRONTIER|STRADA|SAVEIRO|TORO|FIORINO|KANGOO|PARTNER|BERLINGO)\b/.test(v)) tipoVehiculo = 'Pick Up';
    else if (/\b(CAMION|CAMIÓN|SCANIA|IVECO|VOLVO|ACOPLADO|SEMI|TRAILER|CARGO|1114|1215|608|7000)\b/.test(v)) tipoVehiculo = 'Camión';

    if (!matrix[mes]) {
      matrix[mes] = { Auto: 0, 'Pick Up': 0, Moto: 0, Camión: 0, Total: 0 };
    }
    matrix[mes][tipoVehiculo]++;
    matrix[mes].Total++;
  });

  console.log('\n📅 EVOLUCIÓN MENSUAL NRE DIRECTA (DESDE ENERO DE ESTE AÑO HASTA LA FECHA):');
  console.table(matrix);
}

checkNRE2026().catch(console.error);
