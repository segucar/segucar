const db = require('./database');
const ExcelJS = require('exceljs');
const path = require('path');

async function generateReport() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SEGUCar';
  workbook.created = new Date();

  const dates = [
    { mes: 'Junio 2026', date: '2026-06-04' },
    { mes: 'Julio 2026', date: '2026-07-04' },
    { mes: 'Agosto 2026 (Actual)', date: '2026-08-04' }
  ];

  // 1. Pestaña de Evolución y Crecimiento Histórico
  const sheetEvol = workbook.addWorksheet('Comparativa e Historial');
  sheetEvol.columns = [
    { header: 'Tipo de Vehículo', key: 'tipo', width: 20 },
    { header: 'Junio 2026 (Pólizas)', key: 'jun_p', width: 22 },
    { header: 'Julio 2026 (Pólizas)', key: 'jul_p', width: 22 },
    { header: 'Agosto 2026 (Pólizas)', key: 'ago_p', width: 22 },
    { header: 'Crecimiento (Jul vs Jun)', key: 'crec_jul', width: 24 },
    { header: 'Crecimiento (Ago vs Jul)', key: 'crec_ago', width: 24 },
    { header: 'Crecimiento Total (2 Meses)', key: 'crec_tot', width: 26 }
  ];

  const categories = ['Auto', 'Pick Up', 'Moto', 'Camión'];
  const histData = {};
  categories.forEach(c => { histData[c] = { jun: 0, jul: 0, ago: 0 }; });

  for (const d of dates) {
    const key = d.date.includes('-06-') ? 'jun' : (d.date.includes('-07-') ? 'jul' : 'ago');
    const rows = db.prepare(`
      SELECT 
        COALESCE(NULLIF(TRIM(tipo_vehiculo), ''), 'Auto') as tipo,
        COUNT(*) as polizas
      FROM polizas
      WHERE LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja', 'historico', 'historica', 'cancelada')
        AND date(COALESCE(fin_vigencia_poliza, fecha_vencimiento)) >= date(?)
        AND date(COALESCE(fin_vigencia_poliza, fecha_vencimiento), '-90 days') <= date(?)
      GROUP BY tipo
    `).all(d.date, d.date);

    rows.forEach(r => {
      let t = r.tipo.trim();
      t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      if (t === 'Pick up') t = 'Pick Up';
      if (t === 'Camion') t = 'Camión';
      if (histData[t]) histData[t][key] = r.polizas;
    });
  }

  let totJun = 0, totJul = 0, totAgo = 0;
  for (const [tipo, val] of Object.entries(histData)) {
    totJun += val.jun;
    totJul += val.jul;
    totAgo += val.ago;

    const varJul = val.jun > 0 ? (((val.jul - val.jun) / val.jun) * 100).toFixed(1) + '%' : '+100%';
    const varAgo = val.jul > 0 ? (((val.ago - val.jul) / val.jul) * 100).toFixed(1) + '%' : '+100%';
    const varTot = val.jun > 0 ? (((val.ago - val.jun) / val.jun) * 100).toFixed(1) + '%' : '+100%';

    sheetEvol.addRow({
      tipo,
      jun_p: val.jun,
      jul_p: val.jul,
      ago_p: val.ago,
      crec_jul: '+' + varJul,
      crec_ago: '+' + varAgo,
      crec_tot: '+' + varTot
    });
  }

  const varJulTot = (((totJul - totJun) / totJun) * 100).toFixed(1) + '%';
  const varAgoTot = (((totAgo - totJul) / totJul) * 100).toFixed(1) + '%';
  const varTotTot = (((totAgo - totJun) / totJun) * 100).toFixed(1) + '%';

  const totalRow = sheetEvol.addRow({
    tipo: 'TOTAL GENERAL',
    jun_p: totJun,
    jul_p: totJul,
    ago_p: totAgo,
    crec_jul: '+' + varJulTot,
    crec_ago: '+' + varAgoTot,
    crec_tot: '+' + varTotTot
  });
  totalRow.font = { bold: true };

  sheetEvol.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheetEvol.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8E44AD' } };

  // 2. Master Current Active Sheet
  const queryActive = `
    SELECT 
      c.id as cliente_id,
      c.nombre,
      c.dni,
      c.telefono,
      c.direccion,
      c.sin_whatsapp,
      p.operacion,
      p.patente,
      p.vehiculo,
      COALESCE(NULLIF(TRIM(p.tipo_vehiculo), ''), 'Auto') as tipo_vehiculo,
      COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento) as fin_vigencia,
      p.saldo_pendiente,
      p.cuotas_debe
    FROM polizas p
    JOIN clientes c ON p.cliente_id = c.id
    WHERE LOWER(COALESCE(p.estado, '')) NOT IN ('anulada', 'baja', 'historico', 'historica', 'cancelada')
      AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0
      AND NOT EXISTS (
        SELECT 1 FROM polizas p2 
        WHERE p2.patente = p.patente 
          AND p2.id != p.id 
          AND CAST(p2.operacion AS INTEGER) > CAST(p.operacion AS INTEGER)
      )
    ORDER BY p.tipo_vehiculo ASC, c.nombre ASC
  `;

  const rows = db.prepare(queryActive).all();
  const grouped = {};

  rows.forEach(r => {
    let t = (r.tipo_vehiculo || 'Auto').trim();
    t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    if (t === 'Pick up') t = 'Pick Up';
    if (t === 'Camion') t = 'Camión';
    r.tipo_vehiculo = t;

    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(r);
  });

  const sheetDetail = workbook.addWorksheet('Master Actual');
  sheetDetail.columns = [
    { header: 'Tipo Vehículo', key: 'tipo_vehiculo', width: 16 },
    { header: 'Cliente', key: 'nombre', width: 34 },
    { header: 'DNI', key: 'dni', width: 15 },
    { header: 'Teléfono', key: 'telefono', width: 18 },
    { header: 'WhatsApp', key: 'wa', width: 15 },
    { header: 'Patente', key: 'patente', width: 14 },
    { header: 'Vehículo / Modelo', key: 'vehiculo', width: 36 },
    { header: 'N° Operación', key: 'operacion', width: 16 },
    { header: 'Fin Vigencia', key: 'fin_vigencia', width: 15 },
    { header: 'Saldo Impago', key: 'saldo', width: 15 }
  ];

  rows.forEach(r => {
    sheetDetail.addRow({
      tipo_vehiculo: r.tipo_vehiculo,
      nombre: r.nombre,
      dni: r.dni || '-',
      telefono: r.telefono || 'Sin número',
      wa: r.sin_whatsapp ? 'Sin WhatsApp' : (r.telefono ? 'Sí' : 'No'),
      patente: r.patente,
      vehiculo: r.vehiculo,
      operacion: r.operacion,
      fin_vigencia: r.fin_vigencia,
      saldo: r.saldo_pendiente ? `$${r.saldo_pendiente}` : '$0'
    });
  });
  sheetDetail.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheetDetail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF107C41' } };

  // 3. Category Tabs
  for (const [tipo, list] of Object.entries(grouped)) {
    const sheetCat = workbook.addWorksheet(tipo.toUpperCase());
    sheetCat.columns = [
      { header: 'Cliente', key: 'nombre', width: 34 },
      { header: 'DNI', key: 'dni', width: 15 },
      { header: 'Teléfono', key: 'telefono', width: 18 },
      { header: 'WhatsApp', key: 'wa', width: 15 },
      { header: 'Patente', key: 'patente', width: 14 },
      { header: 'Vehículo / Modelo', key: 'vehiculo', width: 36 },
      { header: 'N° Operación', key: 'operacion', width: 16 },
      { header: 'Fin Vigencia', key: 'fin_vigencia', width: 15 },
      { header: 'Saldo Impago', key: 'saldo', width: 15 }
    ];
    list.forEach(r => {
      sheetCat.addRow({
        nombre: r.nombre,
        dni: r.dni || '-',
        telefono: r.telefono || 'Sin número',
        wa: r.sin_whatsapp ? 'Sin WhatsApp' : (r.telefono ? 'Sí' : 'No'),
        patente: r.patente,
        vehiculo: r.vehiculo,
        operacion: r.operacion,
        fin_vigencia: r.fin_vigencia,
        saldo: r.saldo_pendiente ? `$${r.saldo_pendiente}` : '$0'
      });
    });
    sheetCat.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheetCat.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007ACC' } };
  }

  const filePublic = path.join(__dirname, 'public', 'Clientes_Activos_Por_Vehiculo.xlsx');
  await workbook.xlsx.writeFile(filePublic);
  console.log('✅ Archivo Excel con comparativa generado en:', filePublic);
}

generateReport().catch(console.error);
