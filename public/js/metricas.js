/**
 * metricas.js — Módulo de Métricas y Conversión Comercial (SEGUCar)
 */

let currentRangoMetricas = 'este_mes';
let currentCustomDesde = '';
let currentCustomHasta = '';

async function fetchMetricas(rango = currentRangoMetricas, desde = currentCustomDesde, hasta = currentCustomHasta) {
  currentRangoMetricas = rango;
  currentCustomDesde = desde;
  currentCustomHasta = hasta;

  const container = document.getElementById('viewMetricas');
  if (!container) return;

  try {
    let url = `/api/metricas/resumen?rango=${rango}`;
    if (rango === 'custom' && desde && hasta) {
      url += `&desde=${desde}&hasta=${hasta}`;
    }
    const res = await fetch(url);
    const data = await res.json();
    renderMetricasUI(data);
  } catch (err) {
    console.error('Error fetching metricas:', err);
    container.innerHTML = '<div class="card" style="padding:20px; color:var(--danger);">Error al cargar las métricas comerciales.</div>';
  }
}

function changeRangoMetricas(rangoVal) {
  if (rangoVal === 'custom') {
    const customBox = document.getElementById('customDateRangeBox');
    if (customBox) customBox.style.display = 'inline-flex';
    currentRangoMetricas = 'custom';
  } else {
    const customBox = document.getElementById('customDateRangeBox');
    if (customBox) customBox.style.display = 'none';
    fetchMetricas(rangoVal);
  }
}

function applyCustomDateMetricas() {
  const d = document.getElementById('metricasDesde')?.value;
  const h = document.getElementById('metricasHasta')?.value;
  if (!d || !h) {
    if (typeof showToast === 'function') showToast('Seleccioná ambas fechas (desde y hasta)', 'warning');
    return;
  }
  fetchMetricas('custom', d, h);
}

function renderMetricasUI(data) {
  const container = document.getElementById('viewMetricas');
  if (!container) return;

  const dineroFormatted = (data.dinero_recuperado_total || 0).toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2
  });

  const plantillaLabels = {
    'recordatorio_48hs': '🟡 Recordatorio 48 hs (Preventivo)',
    'primer_aviso': '🟠 Primer Aviso (Cuota Vencida)',
    'segundo_aviso': '🔴 Segundo Aviso (Cuota Vencida)',
    'mora_critica': '🚨 Mora Crítica (+96 hs)',
    'renovacion_7_dias': '📄 Aviso Renovación (Vence en 7 Días)',
    'renovacion_deuda': '📄 Póliza: Renovación + Deuda Pendiente',
    'poliza_vencida': '⚫ Aviso Póliza Vencida',
    'recuperacion_historica': '🔄 Propuesta Reactivación Cartera'
  };

  let plantillasRows = '';
  const filteredPerformance = (data.plantillas_performance || []).filter(p => !['mora_critica', 'renovacion_deuda'].includes(p.tipo_plantilla));

  if (filteredPerformance.length > 0) {
    plantillasRows = filteredPerformance.map(p => {
      const nombreLabel = plantillaLabels[p.tipo_plantilla] || p.tipo_plantilla;
      const recFormatted = (p.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
      return `
        <tr>
          <td style="font-weight: 700; color: var(--accent-cyan-light);">${escapeHtml(nombreLabel)}</td>
          <td class="text-center"><strong>${p.total_envios}</strong> ${p.reemplazadas > 0 ? `<span style="font-size:0.75rem; color:var(--text-secondary);" title="Reemplazados por re-envíos">(${p.reemplazadas} re-envíos)</span>` : ''}</td>
          <td class="text-center" style="color: var(--success); font-weight: 700;">${p.exitosos}</td>
          <td class="text-center" style="color: var(--warning);">${p.pendientes}</td>
          <td class="text-center" style="color: var(--danger);">${p.vencidos}</td>
          <td class="text-center">
            <span class="badge" style="background: rgba(0, 180, 216, 0.2); color: #00b4d8; font-weight: 800; font-size: 0.85rem;">
              ${p.tasa_conversion}%
            </span>
          </td>
          <td class="text-right" style="color: var(--success); font-weight: 800;">${recFormatted}</td>
        </tr>
      `;
    }).join('');
  } else {
    plantillasRows = `
      <tr>
        <td colspan="7" class="text-center" style="padding: 2rem; color: var(--text-secondary);">
          📲 Todavía no hay gestiones registradas para este período. Al hacer clic en <strong>Enviar WhatsApp</strong> desde la grilla, los datos aparecerán aquí automáticamente.
        </td>
      </tr>
    `;
  }

  // Like-for-Like Comparison Badges
  const comp = data.comparativa || {};
  let badgeDinero = '';
  let badgeConversion = '';
  const labelComp = comp.prev_mes_label || 'vs período anterior';

  if (comp.var_dinero_pct !== undefined && comp.var_dinero_pct !== null) {
    const isPos = comp.var_dinero_pct >= 0;
    const sign = isPos ? '+' : '';
    const color = isPos ? '#2ed573' : '#ff4757';
    badgeDinero = `<span style="font-size: 0.76rem; font-weight: 800; color: ${color}; background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 6px; border: 1px solid ${color}40; display: inline-flex; align-items: center; margin-left: 8px;">${isPos ? '📈' : '📉'} ${sign}${comp.var_dinero_pct}% ${labelComp}</span>`;
  }

  if (comp.var_conversion_pts !== undefined && comp.var_conversion_pts !== null) {
    const isPos = comp.var_conversion_pts >= 0;
    const sign = isPos ? '+' : '';
    const color = isPos ? '#00b4d8' : '#ff4757';
    badgeConversion = `<span style="font-size: 0.76rem; font-weight: 800; color: ${color}; background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 6px; border: 1px solid ${color}40; display: inline-flex; align-items: center; margin-left: 8px;">${isPos ? '📈' : '📉'} ${sign}${comp.var_conversion_pts} pts ${labelComp}</span>`;
  }

  const exitososSum = (data.exitosos_totales || 0) + (data.exitosos_parciales || 0);
  const validosNum = data.total_validos !== undefined ? data.total_validos : (data.total_envios - (data.reemplazadas || 0));

  container.innerHTML = `
    <!-- HEADER TITLE & CONTROLS TOOLBAR -->
    <div style="margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
      <div>
        <h2 style="font-size: 1.6rem; font-weight: 800; color: var(--text-primary); margin: 0;">📊 Métricas y Conversión Comercial</h2>
        <p style="margin: 4px 0 0 0; color: var(--text-secondary); font-size: 0.88rem;">Medición en tiempo real del cobro de cuotas y renovación de pólizas atribuidos a envíos de WhatsApp.</p>
      </div>
      
      <!-- TOOLBAR BAR (Clean Flex Spacing to Avoid Overlay) -->
      <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 10px; z-index: 100; position: relative;">
        
        <!-- CUSTOM DATE RANGE INPUTS -->
        <div id="customDateRangeBox" style="display: ${currentRangoMetricas === 'custom' ? 'inline-flex' : 'none'}; align-items: center; gap: 6px; background: rgba(255,255,255,0.04); padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);">
          <input type="date" id="metricasDesde" value="${currentCustomDesde}" style="background: rgba(0,0,0,0.3); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.2); padding: 5px 8px; border-radius: 6px; font-size: 0.82rem;">
          <span style="color: var(--text-secondary); font-size: 0.8rem;">a</span>
          <input type="date" id="metricasHasta" value="${currentCustomHasta}" style="background: rgba(0,0,0,0.3); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.2); padding: 5px 8px; border-radius: 6px; font-size: 0.82rem;">
          <button class="btn btn-sm btn-primary" onclick="applyCustomDateMetricas()" style="padding: 5px 10px; font-size: 0.8rem; font-weight: 700;">Filtrar</button>
        </div>

        <select id="selectRangoMetricas" onchange="changeRangoMetricas(this.value)" style="background: rgba(15, 23, 42, 0.95); color: var(--text-primary); border: 1px solid rgba(0, 180, 216, 0.4); padding: 8px 14px; border-radius: 8px; font-weight: 700; font-size: 0.88rem; cursor: pointer; position: relative; z-index: 10;">
          <option value="hoy" ${currentRangoMetricas === 'hoy' ? 'selected' : ''}>☀️ Hoy (Día Actual)</option>
          <option value="esta_semana" ${currentRangoMetricas === 'esta_semana' ? 'selected' : ''}>📆 Esta Semana</option>
          <option value="este_mes" ${currentRangoMetricas === 'este_mes' ? 'selected' : ''}>📅 Este Mes</option>
          <option value="mes_anterior" ${currentRangoMetricas === 'mes_anterior' ? 'selected' : ''}>🗓️ Mes Anterior</option>
          <option value="30_dias" ${currentRangoMetricas === '30_dias' ? 'selected' : ''}>🗓️ Últimos 30 días</option>
          <option value="anio_actual" ${currentRangoMetricas === 'anio_actual' ? 'selected' : ''}>📆 Año Actual</option>
          <option value="custom" ${currentRangoMetricas === 'custom' ? 'selected' : ''}>📅 Rango Personalizado...</option>
          <option value="todo" ${currentRangoMetricas === 'todo' ? 'selected' : ''}>🌐 Todo el Historial</option>
        </select>

        <button class="btn btn-ghost" onclick="fetchMetricas()" style="gap:6px; display:flex; align-items:center; font-weight:700; border:1px solid rgba(255,255,255,0.15); padding: 8px 14px; border-radius: 8px;">
          🔄 Actualizar
        </button>

        <a href="/api/exportar-sin-telefono" class="btn btn-ghost" style="color: var(--accent-cyan-light); border: 1px solid rgba(0, 180, 216, 0.4); background: rgba(0, 180, 216, 0.1); font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px;" title="Descargar reporte Excel unificado con todos los clientes sin teléfono, incompletos o invalidados">
          📱 Exportar Clientes Sin Teléfono
        </a>
      </div>
    </div>

    <!-- KPI CARDS GRID -->
    <div class="stats-grid mb-3" style="grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
      
      <!-- CARD 1: DINERO RECUPERADO -->
      <div class="card" style="padding: 18px; border-top: 4px solid #2ed573;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.5px;">💰 Dinero Recuperado</div>
        </div>
        <div style="font-size: 1.6rem; font-weight: 800; color: #2ed573; margin: 8px 0 4px 0;">${dineroFormatted}</div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); display: flex; align-items: center; flex-wrap: wrap;">
          <span>Atribuido a envíos de WhatsApp</span>
          ${badgeDinero}
        </div>
      </div>

      <!-- CARD 2: TASA DE CONVERSIÓN CON ESTRUCTURA EXACTA Y TOOLTIP -->
      <div class="card" style="padding: 18px; border-top: 4px solid #00b4d8;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.5px;">🎯 Tasa de Conversión</div>
        </div>
        <div style="font-size: 1.6rem; font-weight: 800; color: #00b4d8; margin: 8px 0 4px 0;">${data.tasa_conversion_global}%</div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); line-height: 1.4;">
          <strong>${exitososSum}</strong> cobros de <strong>${validosNum}</strong> envíos únicos
          ${data.reemplazadas > 0 ? `<span style="font-size:0.73rem; color:var(--text-secondary);" title="Total incluyendo reenvíos duplicados: ${data.total_envios}">(${data.total_envios} con reenvíos) <span style="cursor:help; border-bottom:1px dotted var(--text-secondary);" title="La tasa de conversión se calcula estrictamente sobre envíos únicos, sin contar reenvíos duplicados.">ⓘ</span></span>` : ''}
          ${badgeConversion}
        </div>
      </div>

      <!-- CARD 3: TIEMPO PROMEDIO COBRO -->
      <div class="card" style="padding: 18px; border-top: 4px solid #f39c12;">
        <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.5px;">⏱️ Tiempo Promedio Cobro</div>
        <div style="font-size: 1.6rem; font-weight: 800; color: #f39c12; margin: 8px 0 4px 0;">${data.tiempo_promedio_dias} <span style="font-size: 0.9rem;">días</span></div>
        <div style="font-size: 0.75rem; color: var(--text-secondary);">Desde el mensaje hasta el pago NRE</div>
      </div>

      <!-- CARD 4: ESTADO DE GESTIONES -->
      <div class="card" style="padding: 18px; border-top: 4px solid #9b59b6;">
        <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.5px;">📤 Estado de Gestiones</div>
        <div style="font-size: 1.4rem; font-weight: 800; color: var(--text-primary); margin: 8px 0 4px 0;">
          <span style="color:#2ed573;">${exitososSum}</span> / 
          <span style="color:#f1c40f;">${data.pendientes || 0}</span> / 
          <span style="color:#ff4757;">${data.vencidos_sin_pago || 0}</span>
        </div>
        <div style="font-size: 0.75rem; color: var(--text-secondary);">Exitosos / Pendientes / Vencidos ${data.reemplazadas > 0 ? `(${data.reemplazadas} reemplazados)` : ''}</div>
      </div>

    </div>

    <!-- COMPARATIVE TABLE BY TEMPLATE -->
    <div class="card mb-3" style="padding: 24px;">
      <div style="font-size: 0.9rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; margin-bottom: 16px;">
        📋 Rendimiento Comparativo por Plantilla Utilizada
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Plantilla</th>
              <th class="text-center">Envíos</th>
              <th class="text-center">Exitosos</th>
              <th class="text-center">Pendientes</th>
              <th class="text-center">Sin Pago (>7d)</th>
              <th class="text-center">Tasa Conversión</th>
              <th class="text-right">Dinero Recuperado</th>
            </tr>
          </thead>
          <tbody>
            ${plantillasRows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
