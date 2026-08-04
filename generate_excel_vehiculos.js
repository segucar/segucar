const db = require('./database');
const ExcelJS = require('exceljs');
const path = require('path');

async function generateReport() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SEGUCar';
  workbook.created = new Date();

  const query = `
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

  const rows = db.prepare(query).all();

  // 1. Resumen Tab
  const sheetResumen = workbook.addWorksheet('Resumen General');
  sheetResumen.columns = [
    { header: 'Tipo de Vehículo', key: 'tipo', width: 22 },
    { header: 'Clientes Únicos', key: 'clientes', width: 20 },
    { header: 'Pólizas Vigentes', key: 'polizas', width: 22 }
  ];

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

  let totalPol = 0;
  for (const [tipo, list] of Object.entries(grouped)) {
    const uniqueClients = new Set(list.map(x => x.cliente_id)).size;
    sheetResumen.addRow({ tipo, clientes: uniqueClients, polizas: list.length });
    totalPol += list.length;
  }
  sheetResumen.addRow({ tipo: 'TOTAL GENERAL', clientes: new Set(rows.map(x => x.cliente_id)).size, polizas: totalPol });

  sheetResumen.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheetResumen.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007ACC' } };

  // 2. Master Sheet
  const sheetDetail = workbook.addWorksheet('Master Completo');
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

  // 3. Individual Category Tabs
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
  console.log('✅ Archivo Excel generado con éxito en:', filePublic);
}

generateReport().catch(console.error);
