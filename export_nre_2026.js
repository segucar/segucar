const cheerio = require('cheerio');
const ExcelJS = require('exceljs');
const path = require('path');

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

async function exportNRE2026Excel() {
  console.log('🔄 Conectando con NRE (Portal Oficial Emisión)...');
  const { baseUrl, getCookieString } = await loginNRE('SUA', 'sua');

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
  if (!data.tabla) return;

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

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SEGUCar NRE Sync';

  // 1. Matriz de Evolución 2026
  const sheetEvol = workbook.addWorksheet('Evolución NRE 2026');
  sheetEvol.columns = [
    { header: 'Mes de Vencimiento NRE', key: 'mes', width: 25 },
    { header: 'Autos', key: 'auto', width: 14 },
    { header: 'Pick Ups', key: 'pickup', width: 14 },
    { header: 'Motos', key: 'moto', width: 14 },
    { header: 'Camiones', key: 'camion', width: 14 },
    { header: 'Total Pólizas NRE', key: 'total', width: 18 }
  ];

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

  const mesMap = {
    '2026-01': 'Enero 2026', '2026-02': 'Febrero 2026', '2026-03': 'Marzo 2026',
    '2026-04': 'Abril 2026', '2026-05': 'Mayo 2026', '2026-06': 'Junio 2026',
    '2026-07': 'Julio 2026', '2026-08': 'Agosto 2026', '2026-09': 'Septiembre 2026',
    '2026-10': 'Octubre 2026', '2026-11': 'Noviembre 2026'
  };

  let totAuto = 0, totPick = 0, totMoto = 0, totCam = 0, totAll = 0;
  Object.keys(matrix).sort().forEach(m => {
    const item = matrix[m];
    totAuto += item.Auto;
    totPick += item['Pick Up'];
    totMoto += item.Moto;
    totCam += item.Camión;
    totAll += item.Total;

    sheetEvol.addRow({
      mes: mesMap[m] || m,
      auto: item.Auto,
      pickup: item['Pick Up'],
      moto: item.Moto,
      camion: item.Camión,
      total: item.Total
    });
  });

  const totRow = sheetEvol.addRow({
    mes: 'TOTAL ACUMULADO 2026',
    auto: totAuto,
    pickup: totPick,
    moto: totMoto,
    camion: totCam,
    total: totAll
  });
  totRow.font = { bold: true };

  sheetEvol.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheetEvol.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007ACC' } };

  // 2. Detalle de 2918 registros NRE
  const sheetDet = workbook.addWorksheet('Registros NRE 2026');
  sheetDet.columns = [
    { header: 'N° Operación', key: 'operacion', width: 16 },
    { header: 'Cliente (NRE)', key: 'nombre', width: 34 },
    { header: 'Sección', key: 'seccion', width: 15 },
    { header: 'Patente', key: 'patente', width: 14 },
    { header: 'Vehículo / Modelo', key: 'vehiculo', width: 36 },
    { header: 'Teléfono NRE', key: 'telefono', width: 18 },
    { header: 'Fin Vigencia', key: 'finVig', width: 15 },
    { header: 'Estado Renovada', key: 'renovada', width: 18 }
  ];

  rows.forEach(r => sheetDet.addRow(r));
  sheetDet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheetDet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF107C41' } };

  const filePublic = path.join(__dirname, 'public', 'Reporte_NRE_Evolucion_2026.xlsx');
  await workbook.xlsx.writeFile(filePublic);
  console.log('✅ Archivo Reporte_NRE_Evolucion_2026.xlsx generado con éxito.');
}

exportNRE2026Excel().catch(console.error);
