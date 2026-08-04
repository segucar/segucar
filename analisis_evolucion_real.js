// ============================================================================
// ANÁLISIS DE EVOLUCIÓN DE CARTERA — REPORTE HONESTO Y MÉTRICAS DE FLUJO
// ============================================================================

const db = require('./database');

console.log('=== 1) Registros cargados en el sistema por mes (created_at) ===');
const cargaPorMes = db.prepare(`
  SELECT strftime('%Y-%m', created_at) as mes_carga, COUNT(*) as registros_cargados
  FROM polizas
  GROUP BY mes_carga
  ORDER BY mes_carga
`).all();
console.table(cargaPorMes);

console.log('\n=== 2) Carga vs. Vencimiento Real (Detecta carga retroactiva) ===');
const cargaVsVencimiento = db.prepare(`
  SELECT
    strftime('%Y-%m', created_at) as mes_carga,
    strftime('%Y-%m', COALESCE(fin_vigencia_poliza, fecha_vencimiento)) as mes_vencimiento,
    COUNT(*) as cnt
  FROM polizas
  GROUP BY mes_carga, mes_vencimiento
  ORDER BY mes_carga DESC, mes_vencimiento DESC
`).all();
console.table(cargaVsVencimiento.slice(0, 30));

console.log('\n=== 3) Clientes por fecha de primera póliza (Altas por mes de carga/vigencia) ===');
// For start date, trimestral policies start 90 days before fin_vigencia_poliza or fecha_vencimiento
const altasVigencia = db.prepare(`
  WITH primera_poliza AS (
    SELECT cliente_id, MIN(date(COALESCE(fin_vigencia_poliza, fecha_vencimiento), '-90 days')) as fecha_inicio
    FROM polizas
    GROUP BY cliente_id
  )
  SELECT strftime('%Y-%m', fecha_inicio) as mes_inicio, COUNT(*) as clientes_nuevos
  FROM primera_poliza
  WHERE fecha_inicio IS NOT NULL
  GROUP BY mes_inicio
  ORDER BY mes_inicio
`).all();
console.table(altasVigencia);

console.log('\n=== 4) Análisis de la columna "renovada" y sucesoras (Renovó vs No Renovó) ===');
const renovacionesAnalisis = db.prepare(`
  SELECT
    strftime('%Y-%m', COALESCE(p1.fin_vigencia_poliza, p1.fecha_vencimiento)) as mes_vencimiento,
    COUNT(*) as total_vencidas,
    SUM(CASE WHEN EXISTS (
      SELECT 1 FROM polizas p2
      WHERE p2.patente = p1.patente
        AND p2.id != p1.id
        AND CAST(p2.operacion AS INTEGER) > CAST(p1.operacion AS INTEGER)
    ) THEN 1 ELSE 0 END) as renovadas_con_sucesora,
    SUM(CASE WHEN NOT EXISTS (
      SELECT 1 FROM polizas p2
      WHERE p2.patente = p1.patente
        AND p2.id != p1.id
        AND CAST(p2.operacion AS INTEGER) > CAST(p1.operacion AS INTEGER)
    ) THEN 1 ELSE 0 END) as no_renovadas
  FROM polizas p1
  WHERE date(COALESCE(p1.fin_vigencia_poliza, p1.fecha_vencimiento)) <= date('now')
  GROUP BY mes_vencimiento
  ORDER BY mes_vencimiento
`).all();
console.table(renovacionesAnalisis);

console.log('\n📈 Tasa de renovación real por mes (Renovadas / Total Vencidas):');
renovacionesAnalisis.forEach(r => {
  const tasa = r.total_vencidas > 0 ? ((r.renovadas_con_sucesora / r.total_vencidas) * 100).toFixed(1) : '0';
  console.log(`  ${r.mes_vencimiento}: ${tasa}% (${r.renovadas_con_sucesora}/${r.total_vencidas} renovadas)`);
});
