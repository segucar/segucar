/**
 * metricas.js — Módulo de Métricas y Conversión Comercial (SEGUCar)
 */

let currentRangoMetricas = 'este_mes';
let currentCustomDesde = '';
let currentCustomHasta = '';
let currentFetchSeq = 0;
let metricasAbortController = null;
let _metricasDebounceTimer = null;
let _cachedDashboardStats = null;
let _cachedDashboardStatsTimestamp = 0;

// Muestra skeleton en las KPI cards mientras hay un fetch en curso
function _showMetricasLoadingSkeleton() {
  const skeletonCard = (label, color) => `
    <div class="card" style="padding: 18px; border-top: 4px solid ${color}; opacity: 0.65;">
      <div style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700; letter-spacing: 0.5px;">${label}</div>
      <div style="font-size: 1.6rem; font-weight: 800; color: ${color}; margin: 10px 0 6px 0;">
        <span style="display:inline-block; width:180px; height:1.6rem; border-radius:6px; background:linear-gradient(90deg,rgba(255,255,255,0.06) 25%,rgba(255,255,255,0.13) 50%,rgba(255,255,255,0.06) 75%); background-size:400% 100%; animation:_skeletonShimmer 1.2s ease-in-out infinite;"></span>
      </div>
      <div style="font-size: 0.75rem; color: var(--text-secondary);">⏳ Actualizando...</div>
    </div>`;
  if (!document.getElementById('_metricas_shimmer_style')) {
    const s = document.createElement('style');
    s.id = '_metricas_shimmer_style';
    s.textContent = '@keyframes _skeletonShimmer { 0%{background-position:100% 0} 100%{background-position:-100% 0} }';
    document.head.appendChild(s);
  }
  const kpiGrid = document.querySelector('#viewMetricas .stats-grid');
  if (kpiGrid) {
    kpiGrid.innerHTML =
      skeletonCard('💰 Dinero Recuperado', '#2ed573') +
      skeletonCard('🎯 Tasa de Conversión', '#00b4d8') +
      skeletonCard('⏱️ Tiempo Promedio Cobro', '#f39c12') +
      skeletonCard('📤 Estado de Gestiones', '#9b59b6');
  }
}

async function fetchMetricas(rango, desde, hasta, forceRefreshStats = false) {
  const thisSeq = ++currentFetchSeq;

  // Cancel any prior in-flight fetch immediately
  if (metricasAbortController) {
    try { metricasAbortController.abort(); } catch(e){}
  }
  metricasAbortController = new AbortController();
  const signal = metricasAbortController.signal;

  if (rango !== undefined && rango !== null && rango !== '') {
    currentRangoMetricas = rango;
  } else {
    const sel = document.getElementById('selectRangoMetricas');
    if (sel && sel.value) currentRangoMetricas = sel.value;
  }
  if (desde !== undefined && desde !== null) currentCustomDesde = desde;
  if (hasta !== undefined && hasta !== null) currentCustomHasta = hasta;

  const container = document.getElementById('viewMetricas');
  if (!container) return;

  // Mostrar skeleton inmediato en las KPI cards
  _showMetricasLoadingSkeleton();

  try {
    let url = `/api/metricas/resumen?rango=${encodeURIComponent(currentRangoMetricas)}`;
    if (currentRangoMetricas === 'custom' && currentCustomDesde && currentCustomHasta) {
      url += `&desde=${encodeURIComponent(currentCustomDesde)}&hasta=${encodeURIComponent(currentCustomHasta)}`;
    }

    // Estrategia de alto rendimiento: Si las stats de cartera global ya están cacheadas
    // (TTL 60 segundos), solo consultamos el endpoint de métricas. El cambio de período es instantáneo.
    const now = Date.now();
    const needsStats = forceRefreshStats || !_cachedDashboardStats || (now - _cachedDashboardStatsTimestamp > 60000);

    const promises = [fetch(url, { signal })];
    if (needsStats) {
      promises.push(fetch('/api/dashboard/stats', { signal }));
    }

    const responses = await Promise.all(promises);

    if (thisSeq !== currentFetchSeq) {
      // Stale response: a newer request was dispatched, discard this one!
      return;
    }

    const data = await responses[0].json();
    if (needsStats && responses[1]) {
      _cachedDashboardStats = await responses[1].json();
      _cachedDashboardStatsTimestamp = Date.now();
    }
    const stats = _cachedDashboardStats || {};

    // Validación de rango: descartar respuestas que llegaron tarde para un período distinto al actual
    if (data.rango && data.rango !== currentRangoMetricas) {
      console.warn(`[Métricas] Respuesta obsoleta descartada: esperado="${currentRangoMetricas}", recibido="${data.rango}"`);
      return;
    }

    renderMetricasUI(data, stats);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (thisSeq !== currentFetchSeq) return;
    console.error('Error fetching metricas:', err);
    container.innerHTML = '<div class="card" style="padding:20px; color:var(--danger);">Error al cargar las métricas comerciales.</div>';
  }
}


function changeRangoMetricas(rangoVal) {
  if (!rangoVal) {
    const sel = document.getElementById('selectRangoMetricas');
    if (sel) rangoVal = sel.value;
  }
  if (!rangoVal) return;
  currentRangoMetricas = rangoVal;

  // Toggle UI de rango personalizado: inmediato, sin debounce
  const customBox = document.getElementById('customDateRangeBox');
  if (rangoVal === 'custom') {
    if (customBox) customBox.style.display = 'inline-flex';
    // No fetch hasta que el usuario confirme el rango custom
  } else {
    if (customBox) customBox.style.display = 'none';
    // Debounce 150ms antes del fetch: evita 503 en Render por ráfagas de cambios
    clearTimeout(_metricasDebounceTimer);
    _metricasDebounceTimer = setTimeout(() => fetchMetricas(rangoVal), 150);
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

// Ensure functions are globally accessible
window.changeRangoMetricas = changeRangoMetricas;
window.fetchMetricas = fetchMetricas;
window.applyCustomDateMetricas = applyCustomDateMetricas;

function renderMetricasUI(data, stats = {}) {
  const container = document.getElementById('viewMetricas');
  if (!container) return;

  const dineroFormatted = (data.dinero_recuperado_total || 0).toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2
  });

  const plantillaLabels = {
    'recordatorio_48hs': '🟡 Recordatorio 48 hs (Preventivo)',
    'recordatorio_preventivo_48hs': '🟡 Recordatorio 48 hs (Preventivo)',
    'primer_aviso': '🟠 Primer Aviso (Cuota Vencida)',
    'primer_aviso_vencida_48hs': '🟠 Primer Aviso (Cuota Vencida)',
    'segundo_aviso': '🔴 Segundo Aviso (Cuota Vencida)',
    'cuota_segundo_aviso_vencida_hace_96_hs': '🔴 Segundo Aviso (Cuota Vencida)',
    'mora_critica': '🚨 Mora Crítica (+96 hs)',
    'renovacion_7_dias': '📄 Aviso Renovación (Vence en 7 Días)',
    'aviso_renovacion_7_dias': '📄 Aviso Renovación (Vence en 7 Días)',
    'renovacion_deuda': '📄 Póliza: Renovación + Deuda Pendiente',
    'poliza_vencida': '⚫ Aviso Póliza Vencida',
    'aviso_renovacion_poliza_vencida': '⚫ Aviso Póliza Vencida',
    'aviso_renovacion_poliza_vencida_v2': '⚫ Aviso Póliza Vencida',
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

  const activeRango = data.rango || currentRangoMetricas || 'este_mes';
  currentRangoMetricas = activeRango;

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
        <div id="customDateRangeBox" style="display: ${activeRango === 'custom' ? 'inline-flex' : 'none'}; align-items: center; gap: 6px; background: rgba(255,255,255,0.04); padding: 4px 8px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);">
          <input type="date" id="metricasDesde" value="${currentCustomDesde}" style="background: rgba(0,0,0,0.3); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.2); padding: 5px 8px; border-radius: 6px; font-size: 0.82rem;">
          <span style="color: var(--text-secondary); font-size: 0.8rem;">a</span>
          <input type="date" id="metricasHasta" value="${currentCustomHasta}" style="background: rgba(0,0,0,0.3); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.2); padding: 5px 8px; border-radius: 6px; font-size: 0.82rem;">
          <button class="btn btn-sm btn-primary" onclick="applyCustomDateMetricas()" style="padding: 5px 10px; font-size: 0.8rem; font-weight: 700;">Filtrar</button>
        </div>

        <select id="selectRangoMetricas" onchange="changeRangoMetricas(this.value)" style="background: rgba(15, 23, 42, 0.95); color: var(--text-primary); border: 1px solid rgba(0, 180, 216, 0.4); padding: 8px 14px; border-radius: 8px; font-weight: 700; font-size: 0.88rem; cursor: pointer; position: relative; z-index: 10;">
          <option value="hoy" ${activeRango === 'hoy' ? 'selected' : ''}>☀️ Hoy (Día Actual)</option>
          <option value="esta_semana" ${activeRango === 'esta_semana' ? 'selected' : ''}>📆 Esta Semana</option>
          <option value="este_mes" ${activeRango === 'este_mes' ? 'selected' : ''}>📅 Este Mes</option>
          <option value="mes_anterior" ${activeRango === 'mes_anterior' ? 'selected' : ''}>🗓️ Mes Anterior</option>
          <option value="30_dias" ${activeRango === '30_dias' ? 'selected' : ''}>🗓️ Últimos 30 días</option>
          <option value="anio_actual" ${activeRango === 'anio_actual' ? 'selected' : ''}>📆 Año Actual</option>
          <option value="custom" ${activeRango === 'custom' ? 'selected' : ''}>📅 Rango Personalizado...</option>
          <option value="todo" ${activeRango === 'todo' ? 'selected' : ''}>🌐 Todo el Historial</option>
        </select>

        <button class="btn btn-ghost" onclick="fetchMetricas(undefined, undefined, undefined, true)" style="gap:6px; display:flex; align-items:center; font-weight:700; border:1px solid rgba(255,255,255,0.15); padding: 8px 14px; border-radius: 8px;">
          🔄 Actualizar
        </button>

        <a href="/api/exportar-sin-telefono" class="btn btn-ghost" style="color: var(--accent-cyan-light); border: 1px solid rgba(0, 180, 216, 0.4); background: rgba(0, 180, 216, 0.1); font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px;" title="Descargar reporte Excel unificado con todos los clientes sin teléfono, incompletos o invalidados">
          📱 Exportar Clientes Sin Teléfono
        </a>
      </div>
    </div>

    <!-- CUADRO DE MANDO ESTRATÉGICO (7 TARJETAS) -->
    <div class="card mb-3" style="padding: 18px 20px; background: rgba(10, 25, 47, 0.9); border: 1px solid var(--border-color); border-radius: 14px; margin-bottom: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.3);">
      <div style="font-size: 0.82rem; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #48cae4; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span style="display: flex; align-items: center; gap: 8px;">
          <span>🎯</span> CUADRO DE MANDO ESTRATÉGICO — RESUMEN GLOBAL DE CARTERA
        </span>
        <span style="font-size: 0.72rem; color: var(--text-secondary); text-transform: none;">Accesos directos con filtros automáticos</span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px;">
        <!-- 1. Cartera Total -->
        <button class="action-card-btn" onclick="openViewWithFilter('cobranza', 'al_dia')" style="background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">👥</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #00b4d8;">${(stats.cartera_activa_total || stats.total_polizas || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Cartera Activa Total</div>
          <div style="font-size: 0.72rem; color: var(--accent-cyan-light); margin-top: 2px;">Vigentes + Avisos</div>
        </button>

        <!-- 2. Al Día -->
        <button class="action-card-btn" onclick="openViewWithFilter('cobranza', 'al_dia')" style="background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">🟢</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #2ed573;">${(stats.al_dia_estricto || stats.al_dia || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Al Día (Sin mora)</div>
          <div style="font-size: 0.72rem; color: #2ed573; margin-top: 2px;">Sin cuotas vencidas</div>
        </button>

        <!-- 3. Avisos Cobranza -->
        <button class="action-card-btn" onclick="openViewWithFilter('cobranza', 'vencio_48h')" style="background: rgba(230, 126, 34, 0.08); border: 1px solid rgba(230, 126, 34, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">⚠️</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #e67e22;">${(stats.cobranza_avisos_total || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Avisos Cobranza</div>
          <div style="font-size: 0.72rem; color: #e67e22; margin-top: 2px;">48h + 1° y 2° aviso</div>
        </button>

        <!-- 4. Contrato Vigente -->
        <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'vigente')" style="background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">🛡️</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #2ed573;">${(stats.polizas_vigentes_puras || stats.polizas_vigentes || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Contrato Vigente</div>
          <div style="font-size: 0.72rem; color: #2ed573; margin-top: 2px;">Vigencia > 7 días</div>
        </button>

        <!-- 5. Aviso Renovación (7d) -->
        <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'por_vencer')" style="background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">📄</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #00b4d8;">${(stats.polizas_vencen_semana || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Aviso Renovación</div>
          <div style="font-size: 0.72rem; color: var(--accent-cyan-light); margin-top: 2px;">Vence en 7 días</div>
        </button>

        <!-- 6. Póliza Vencida (1-30d) -->
        <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'poliza_vencida')" style="background: rgba(231, 76, 60, 0.08); border: 1px solid rgba(231, 76, 60, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">⏳</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #e74c3c;">${(stats.polizas_vencidas_limpias || stats.polizas_vencidas || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Póliza Vencida</div>
          <div style="font-size: 0.72rem; color: #ff7675; margin-top: 2px;">Vencida hace 1-30d</div>
        </button>

        <!-- 7. Históricas / Bajas -->
        <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'recuperar')" style="background: rgba(162, 155, 254, 0.08); border: 1px solid rgba(162, 155, 254, 0.35); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.3rem;">📦</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #a29bfe;">${(stats.polizas_historicas_total || stats.total_recuperar || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.82rem; color: var(--text-primary); margin-top: 4px;">Históricas / Bajas</div>
          <div style="font-size: 0.72rem; color: #a29bfe; margin-top: 2px;">Bajas mora + >30d</div>
        </button>
      </div>
    </div>

    <!-- 📊 CARTERA ACTUAL POR TIPO DE VEHÍCULO (5 TARJETAS) -->
    <div class="card mb-3" style="padding: 18px 20px; background: rgba(10, 25, 47, 0.85); border: 1px solid var(--border-color); border-radius: 14px; margin-bottom: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);">
      <div style="font-size: 0.82rem; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; color: #48cae4; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span style="display: flex; align-items: center; gap: 8px;">
          <span>📊</span> CARTERA ACTUAL POR TIPO DE VEHÍCULO
        </span>
        <span style="font-size: 0.72rem; color: #a0aec0; text-transform: none; background: rgba(0, 180, 216, 0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(0, 180, 216, 0.25); font-weight: 600;">
          Total Cartera Activa: <strong id="dashVehTotal" style="color: #fff;">${(stats.cartera_activa_total || stats.total_polizas || 0).toLocaleString('es-AR')}</strong>
        </span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
        <!-- 1. Autos -->
        <button class="action-card-btn" onclick="openViewWithVehicleFilter('Auto')" style="background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.35); text-align: left; padding: 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.5rem;">🚗</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #48cae4;" id="dashVehAutos">${(stats.vehiculos_desglose?.autos || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); margin-top: 5px;">Autos</div>
          <div style="font-size: 0.72rem; color: var(--accent-cyan-light); margin-top: 2px; font-weight: 600;" id="dashVehAutosPct">${stats.vehiculos_porcentajes?.autos || '0'}% de cartera →</div>
        </button>

        <!-- 2. Pick Ups / Utilitarios -->
        <button class="action-card-btn" onclick="openViewWithVehicleFilter('Pick Up')" style="background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.35); text-align: left; padding: 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.5rem;">🛻</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #2ed573;" id="dashVehPickups">${(stats.vehiculos_desglose?.pickups || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); margin-top: 5px;">Pick Ups / Utilitarios</div>
          <div style="font-size: 0.72rem; color: #2ed573; margin-top: 2px; font-weight: 600;" id="dashVehPickupsPct">${stats.vehiculos_porcentajes?.pickups || '0'}% de cartera →</div>
        </button>

        <!-- 3. Motos -->
        <button class="action-card-btn" onclick="openViewWithVehicleFilter('Moto')" style="background: rgba(241, 196, 15, 0.08); border: 1px solid rgba(241, 196, 15, 0.35); text-align: left; padding: 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.5rem;">🏍️</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #f39c12;" id="dashVehMotos">${(stats.vehiculos_desglose?.motos || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); margin-top: 5px;">Motos</div>
          <div style="font-size: 0.72rem; color: #f39c12; margin-top: 2px; font-weight: 600;" id="dashVehMotosPct">${stats.vehiculos_porcentajes?.motos || '0'}% de cartera →</div>
        </button>

        <!-- 4. Camiones -->
        <button class="action-card-btn" onclick="openViewWithVehicleFilter('Camión')" style="background: rgba(162, 155, 254, 0.08); border: 1px solid rgba(162, 155, 254, 0.35); text-align: left; padding: 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.5rem;">🚛</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #a29bfe;" id="dashVehCamiones">${(stats.vehiculos_desglose?.camiones || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); margin-top: 5px;">Camiones</div>
          <div style="font-size: 0.72rem; color: #a29bfe; margin-top: 2px; font-weight: 600;" id="dashVehCamionesPct">${stats.vehiculos_porcentajes?.camiones || '0'}% de cartera →</div>
        </button>

        <!-- 5. Sin clasificar -->
        <button class="action-card-btn" onclick="openViewWithVehicleFilter('sin_clasificar')" style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.15); text-align: left; padding: 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size: 1.5rem;">❓</span>
            <span style="font-size: 1.35rem; font-weight: 800; color: #a0aec0;" id="dashVehSinClasificar">${(stats.vehiculos_desglose?.sin_clasificar || 0).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); margin-top: 5px;">Sin clasificar</div>
          <div style="font-size: 0.72rem; color: #a0aec0; margin-top: 2px; font-weight: 600;" id="dashVehSinClasificarPct">${stats.vehiculos_porcentajes?.sin_clasificar || '0'}% de cartera →</div>
        </button>
      </div>
    </div>

    <!-- 🛡️ DESGLOSE DE COBERTURAS POR TIPO DE VEHÍCULO (TABLA CRUZADA AUDITADA) -->
    ${renderTablaCoberturasPorVehiculo(stats.cobertura_vehiculos || data.cobertura_vehiculos)}

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

    <!-- CARTERA & DESGLOSE POR ASEGURADORA -->
    ${renderDesgloseAseguradoras(data.desglose_aseguradora, data.cobertura_contacto)}

    <!-- CONVERSIÓN POR ETAPA DE COBRANZA -->
    ${renderEtapasCobranza(data.etapas_cobranza)}

    <!-- EMBUDO DE CONVERSIÓN COMERCIAL (FUNNEL) -->
    ${renderFunnelConversion(data.funnel_conversion)}

    <!-- HISTÓRICO SEMANAL TRAJECTORY CHART -->
    ${renderHistoricoSemanalChart(data.historico_semanal)}

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

function renderEtapasCobranza(etapas) {
  if (!etapas) return '';
  const r48 = etapas.recordatorio_48hs || {};
  const a1 = etapas.primer_aviso || {};
  const a2 = etapas.segundo_aviso || {};

  const r48Dinero = (r48.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const a1Dinero = (a1.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const a2Dinero = (a2.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  return `
    <div class="card mb-3" style="padding: 22px; margin-bottom: 24px; border: 1px solid var(--border-color); background: rgba(10, 25, 47, 0.85); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px;">
            🔄 Conversión y Eficacia por Etapa de Cobranza
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Porcentaje de clientes que abonan en cada instancia antes de escalar a la siguiente etapa o a Baja
          </div>
        </div>
        <span style="font-size: 0.72rem; color: var(--accent-cyan-light); background: rgba(0, 180, 216, 0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(0, 180, 216, 0.25); font-weight: 700;">
          Secuencia Preventiva y de Mora
        </span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px;">
        <!-- ETAPA 1: RECORDATORIO 48HS -->
        <div style="background: rgba(241, 196, 15, 0.06); border: 1px solid rgba(241, 196, 15, 0.3); border-radius: 12px; padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 800; font-size: 0.88rem; color: #f39c12;">🟡 1. Recordatorio 48 hs</div>
            <span class="badge" style="background: rgba(241, 196, 15, 0.18); color: #f39c12; font-weight: 800;">${r48.tasa_conversion}% conv.</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 12px;">Preventivo (Antes del vencimiento)</div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">
            <div>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">Envíos / Éxitos</div>
              <div style="font-size: 1.05rem; font-weight: 800; color: var(--text-primary);">${r48.envios_unicos || 0} / <span style="color:#2ed573;">${r48.exitosos || 0}</span></div>
            </div>
            <div>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">Recuperado</div>
              <div style="font-size: 1.05rem; font-weight: 800; color: #2ed573;">${r48Dinero}</div>
            </div>
          </div>
        </div>

        <!-- ETAPA 2: PRIMER AVISO -->
        <div style="background: rgba(230, 126, 34, 0.06); border: 1px solid rgba(230, 126, 34, 0.3); border-radius: 12px; padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 800; font-size: 0.88rem; color: #e67e22;">🟠 2. Primer Aviso (48 hs)</div>
            <span class="badge" style="background: rgba(230, 126, 34, 0.18); color: #e67e22; font-weight: 800;">${a1.tasa_conversion}% conv.</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 12px;">Mora temprana (Vencida hace 48 hs)</div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">
            <div>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">Envíos / Éxitos</div>
              <div style="font-size: 1.05rem; font-weight: 800; color: var(--text-primary);">${a1.envios_unicos || 0} / <span style="color:#2ed573;">${a1.exitosos || 0}</span></div>
            </div>
            <div>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">Recuperado</div>
              <div style="font-size: 1.05rem; font-weight: 800; color: #2ed573;">${a1Dinero}</div>
            </div>
          </div>
        </div>

        <!-- ETAPA 3: SEGUNDO AVISO -->
        <div style="background: rgba(231, 76, 60, 0.06); border: 1px solid rgba(231, 76, 60, 0.3); border-radius: 12px; padding: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 800; font-size: 0.88rem; color: #e74c3c;">🔴 3. Segundo Aviso (96 hs)</div>
            <span class="badge" style="background: rgba(231, 76, 60, 0.18); color: #e74c3c; font-weight: 800;">${a2.tasa_conversion}% conv.</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 12px;">Último aviso WhatsApp antes de Baja</div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px;">
            <div>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">Envíos / Éxitos</div>
              <div style="font-size: 1.05rem; font-weight: 800; color: var(--text-primary);">${a2.envios_unicos || 0} / <span style="color:#2ed573;">${a2.exitosos || 0}</span></div>
            </div>
            <div>
              <div style="font-size: 0.7rem; color: var(--text-secondary);">Fuga a Baja (>96h)</div>
              <div style="font-size: 1.05rem; font-weight: 800; color: #ff7675;">${a2.fuga_a_baja || 0} <span style="font-size:0.7rem; font-weight:400;">sin pago</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderFunnelConversion(funnel) {
  if (!funnel) return '';
  const tot = funnel.total_envios || 0;
  const unicos = funnel.envios_unicos || 0;
  const exitosos = funnel.exitosos || 0;
  const dineroFmt = (funnel.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  const pctUnicos = tot > 0 ? ((unicos / tot) * 100).toFixed(1) : '100';
  const pctExitos = unicos > 0 ? ((exitosos / unicos) * 100).toFixed(1) : '0';

  return `
    <div class="card mb-3" style="padding: 22px; margin-bottom: 24px; border: 1px solid var(--border-color); background: rgba(10, 25, 47, 0.85); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px;">
            🌪️ Embudo de Conversión Comercial (Funnel)
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Flujo de conversión desde el disparo de mensajes hasta la recaudación efectiva en cuenta
          </div>
        </div>
        <span style="font-size: 0.75rem; font-weight: 800; color: #2ed573; background: rgba(46, 213, 115, 0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(46, 213, 115, 0.25);">
          Total Recaudado: ${dineroFmt}
        </span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px;">
        <!-- Nivel 1: Total Envíos -->
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.2rem;">📤</span>
            <div>
              <div style="font-size: 0.85rem; font-weight: 700; color: var(--text-primary);">1. Total Mensajes Enviados</div>
              <div style="font-size: 0.74rem; color: var(--text-secondary);">Disparos totales emitidos por WhatsApp (incluye reintentos)</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 1.15rem; font-weight: 800; color: #00b4d8;">${tot.toLocaleString('es-AR')}</div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">100% base</div>
          </div>
        </div>

        <!-- Nivel 2: Contactos Únicos -->
        <div style="background: rgba(0, 180, 216, 0.05); border: 1px solid rgba(0, 180, 216, 0.25); border-radius: 10px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; margin-left: 15px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.2rem;">👥</span>
            <div>
              <div style="font-size: 0.85rem; font-weight: 700; color: var(--text-primary);">2. Clientes Únicos Contactados</div>
              <div style="font-size: 0.74rem; color: var(--text-secondary);">Pólizas / Clientes individuales gestionados en el período</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 1.15rem; font-weight: 800; color: #48cae4;">${unicos.toLocaleString('es-AR')}</div>
            <div style="font-size: 0.72rem; color: var(--accent-cyan-light);">${pctUnicos}% de envíos</div>
          </div>
        </div>

        <!-- Nivel 3: Pagos Exitosos -->
        <div style="background: rgba(46, 213, 115, 0.07); border: 1px solid rgba(46, 213, 115, 0.35); border-radius: 10px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; margin-left: 30px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.2rem;">💰</span>
            <div>
              <div style="font-size: 0.85rem; font-weight: 700; color: #2ed573;">3. Pagos y Cobros Exitosos Confirmados</div>
              <div style="font-size: 0.74rem; color: var(--text-secondary);">Clientes que cancelaron su saldo o renovaron tras el aviso</div>
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 1.25rem; font-weight: 800; color: #2ed573;">${exitosos.toLocaleString('es-AR')}</div>
            <div style="font-size: 0.74rem; font-weight: 700; color: #2ed573;">${pctExitos}% de conversión</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderHistoricoSemanalChart(historico) {
  if (!historico || historico.length === 0) return '';
  const maxDinero = Math.max(1, ...historico.map(h => h.dinero_recuperado || 0));

  const bars = historico.map(h => {
    const barHeightPct = Math.round(((h.dinero_recuperado || 0) / maxDinero) * 100);
    const dineroFmt = (h.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
    const ratio = parseFloat(h.reenvios_ratio || 1.0);
    const isSpamRisk = ratio >= 2.50;
    const ratioColor = isSpamRisk ? '#ff7675' : '#a0aec0';
    const ratioTitle = isSpamRisk ? `⚠️ Alerta: ${ratio.toFixed(2)}x reenvíos/cliente (Riesgo de saturación WA)` : `${ratio.toFixed(2)}x reenvíos por cliente`;

    return `
      <div style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 75px;">
        <div style="font-size: 0.72rem; font-weight: 800; color: #2ed573;">${dineroFmt}</div>
        <div style="font-size: 0.68rem; font-weight: 700; color: #00b4d8; background: rgba(0, 180, 216, 0.15); padding: 2px 6px; border-radius: 4px;">${h.tasa_conversion}%</div>
        <div style="width: 100%; max-width: 42px; height: 110px; background: rgba(255,255,255,0.04); border-radius: 6px; display: flex; align-items: flex-end; overflow: hidden; position: relative;">
          <div style="width: 100%; height: ${Math.max(4, barHeightPct)}%; background: linear-gradient(180deg, #2ed573 0%, #00b4d8 100%); border-radius: 4px 4px 0 0; transition: height 0.3s ease;" title="${h.semana} (${h.label}): ${dineroFmt} recuperados en ${h.exitosos} pagos de ${h.envios} envíos"></div>
        </div>
        <div style="font-size: 0.78rem; font-weight: 700; color: var(--text-primary); margin-top: 2px;">${h.semana}</div>
        <div style="font-size: 0.68rem; color: var(--text-secondary);">${h.label}</div>
        <div style="font-size: 0.65rem; font-weight: 700; color: ${ratioColor}; background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 4px; border: 1px solid ${ratioColor}40;" title="${ratioTitle}">
          ${ratio.toFixed(2)}x ${isSpamRisk ? '⚠️' : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card mb-3" style="padding: 24px; margin-bottom: 24px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px;">
            📈 Trayectoria Histórica Semanal & Reenvíos (Últimas 8 Semanas)
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Evolución del dinero recuperado, tasa de conversión y ratio promedio de reenvíos por cliente
          </div>
        </div>
        <div style="display: flex; gap: 14px; font-size: 0.78rem; font-weight: 700; flex-wrap: wrap;">
          <span style="display: flex; align-items: center; gap: 6px; color: #2ed573;">
            <span style="width: 10px; height: 10px; background: #2ed573; border-radius: 2px; display: inline-block;"></span> Dinero Recuperado
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #00b4d8;">
            <span style="width: 10px; height: 10px; background: #00b4d8; border-radius: 2px; display: inline-block;"></span> % Conversión
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #a0aec0;">
            <span style="font-size: 0.75rem;">🔁</span> Ratio Reenvíos
          </span>
        </div>
      </div>
      <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding: 10px 0; overflow-x: auto;">
        ${bars}
      </div>
    </div>
  `;
}

function renderDesgloseAseguradoras(desglose, cobertura) {
  if (!desglose) return '';
  const nre = desglose.nre || {};
  const ags = desglose.ags || {};
  const nreDinero = (nre.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const agsDinero = (ags.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const nreUnicos = nre.envios_unicos !== undefined ? nre.envios_unicos : Math.max(0, (nre.total_envios || 0) - (nre.reemplazadas || 0));
  const agsUnicos = ags.envios_unicos !== undefined ? ags.envios_unicos : Math.max(0, (ags.total_envios || 0) - (ags.reemplazadas || 0));
  const nreTicket = (nre.ticket_promedio_envio || (nreUnicos > 0 ? Math.round((nre.dinero_recuperado || 0) / nreUnicos) : 0)).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const agsTicket = (ags.ticket_promedio_envio || (agsUnicos > 0 ? Math.round((ags.dinero_recuperado || 0) / agsUnicos) : 0)).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  return `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px;">
      
      <!-- NRE PERFORMANCE CARD -->
      <div class="card" style="padding: 18px; border-left: 4px solid #2ed573;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <div style="font-size: 0.88rem; font-weight: 800; color: #2ed573;">
            🟢 TRIUNVIRATO SEGUROS (NRE)
          </div>
          <span class="badge" style="background: rgba(46, 213, 115, 0.15); color: #2ed573; font-weight: 800;">${nre.tasa_conversion}% conv.</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
          <div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">Recuperado</div>
            <div style="font-size: 1.15rem; font-weight: 800; color: var(--text-primary);">${nreDinero}</div>
          </div>
          <div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">Envíos Únicos / Éxitos</div>
            <div style="font-size: 1.0rem; font-weight: 700; color: var(--text-primary);">
              ${nreUnicos} / <span style="color:#2ed573;">${nre.exitosos || 0}</span>
              ${nre.total_envios > nreUnicos ? `<div style="font-size:0.68rem; font-weight:400; color:var(--text-secondary);" title="Total con reenvíos: ${nre.total_envios}">(${nre.total_envios} tot.)</div>` : ''}
            </div>
          </div>
          <div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">$ / Envío Único</div>
            <div style="font-size: 1.05rem; font-weight: 800; color: #2ed573;" title="Dinero recuperado dividido por envíos únicos">${nreTicket}</div>
          </div>
        </div>
      </div>

      <!-- AGS PERFORMANCE CARD -->
      <div class="card" style="padding: 18px; border-left: 4px solid #1e88e5;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <div style="font-size: 0.88rem; font-weight: 800; color: #64b5f6;">
            🔵 AGROSALTA (AGS)
          </div>
          <span class="badge" style="background: rgba(30, 136, 229, 0.15); color: #64b5f6; font-weight: 800;">${ags.tasa_conversion}% conv.</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
          <div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">Recuperado</div>
            <div style="font-size: 1.15rem; font-weight: 800; color: var(--text-primary);">${agsDinero}</div>
          </div>
          <div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">Envíos Únicos / Éxitos</div>
            <div style="font-size: 1.0rem; font-weight: 700; color: var(--text-primary);">
              ${agsUnicos} / <span style="color:#64b5f6;">${ags.exitosos || 0}</span>
              ${ags.total_envios > agsUnicos ? `<div style="font-size:0.68rem; font-weight:400; color:var(--text-secondary);" title="Total con reenvíos: ${ags.total_envios}">(${ags.total_envios} tot.)</div>` : ''}
            </div>
          </div>
          <div>
            <div style="font-size: 0.72rem; color: var(--text-secondary);">$ / Envío Único</div>
            <div style="font-size: 1.05rem; font-weight: 800; color: #64b5f6;" title="Dinero recuperado dividido por envíos únicos">${agsTicket}</div>
          </div>
        </div>
      </div>

      <!-- CONTACT COVERAGE KPI CARD -->
      <div class="card" style="padding: 18px; border-left: 4px solid #a29bfe;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <div style="font-size: 0.88rem; font-weight: 800; color: #a29bfe;">
            📱 COBERTURA DE TELÉFONOS
          </div>
          <span class="badge" style="background: rgba(162, 155, 254, 0.15); color: #a29bfe; font-weight: 800;">${cobertura?.porcentaje || 0}% total</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div>
            <div style="font-size: 0.74rem; color: var(--text-secondary);">Con Teléfono Válido</div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #00b894;">${(cobertura?.con_telefono || 0).toLocaleString('es-AR')}</div>
          </div>
          <div>
            <div style="font-size: 0.74rem; color: var(--text-secondary);">Faltantes</div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #ff7675;">${(cobertura?.sin_telefono || 0).toLocaleString('es-AR')}</div>
          </div>
        </div>
      </div>

    </div>
  `;
}

function renderTablaCoberturasPorVehiculo(coberturaData) {
  if (!coberturaData) return '';
  const c = coberturaData;
  const autos = c.autos || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, pendiente: 0, total: 0 };
  const pickups = c.pickups || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, pendiente: 0, total: 0 };
  const motos = c.motos || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, pendiente: 0, total: 0 };
  const camiones = c.camiones || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, pendiente: 0, total: 0 };
  const sinClasificar = c.sin_clasificar || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, pendiente: 0, total: 0 };
  const totales = c.totales || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, pendiente: 0, total: 0 };

  const totalConfirmadas = (totales.total || 0) - (totales.pendiente || 0);
  const pctConfirmadas = totales.total > 0 ? ((totalConfirmadas / totales.total) * 100).toFixed(1) : '0';
  const pctPendiente = totales.total > 0 ? ((totales.pendiente / totales.total) * 100).toFixed(1) : '0';

  const rows = [
    { key: 'Auto', icon: '🚗', name: 'Autos', data: autos, color: '#48cae4', filter: 'Auto' },
    { key: 'Pick Up', icon: '🛻', name: 'Pick Ups / Utilitarios', data: pickups, color: '#2ed573', filter: 'Pick Up' },
    { key: 'Moto', icon: '🏍️', name: 'Motos', data: motos, color: '#f39c12', filter: 'Moto' },
    { key: 'Camión', icon: '🚛', name: 'Camiones', data: camiones, color: '#a29bfe', filter: 'Camión' }
  ];

  if (sinClasificar.total > 0) {
    rows.push({ key: 'sin_clasificar', icon: '❓', name: 'Sin clasificar', data: sinClasificar, color: '#a0aec0', filter: 'sin_clasificar' });
  }

  const trs = rows.map(r => {
    const d = r.data;
    return `
      <tr style="transition: background 0.15s ease;">
        <td style="font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.15rem;">${r.icon}</span>
          <span style="color: ${r.color}; font-weight: 800;">${r.name}</span>
        </td>
        <td class="text-center" style="font-weight: 700; color: ${d.rc > 0 ? '#48cae4' : 'var(--text-secondary)'};">
          ${d.rc > 0 ? `<span class="badge" style="background: rgba(0, 180, 216, 0.18); color: #48cae4; font-weight: 800; font-size: 0.85rem;">${d.rc.toLocaleString('es-AR')}</span>` : '<span style="color: rgba(255,255,255,0.25);">0</span>'}
        </td>
        <td class="text-center" style="font-weight: 700; color: ${d.plan_b > 0 ? '#2ed573' : 'var(--text-secondary)'};">
          ${d.plan_b > 0 ? `<span class="badge" style="background: rgba(46, 213, 115, 0.18); color: #2ed573; font-weight: 800; font-size: 0.85rem;">${d.plan_b.toLocaleString('es-AR')}</span>` : '<span style="color: rgba(255,255,255,0.25);">0</span>'}
        </td>
        <td class="text-center" style="font-weight: 700; color: ${d.plan_c > 0 ? '#f1c40f' : 'var(--text-secondary)'};">
          ${d.plan_c > 0 ? `<span class="badge" style="background: rgba(241, 196, 15, 0.18); color: #f1c40f; font-weight: 800; font-size: 0.85rem;">${d.plan_c.toLocaleString('es-AR')}</span>` : '<span style="color: rgba(255,255,255,0.25);">0</span>'}
        </td>
        <td class="text-center" style="background: rgba(243, 156, 18, 0.04);">
          <span class="badge" style="background: rgba(243, 156, 18, 0.15); color: #f39c12; font-weight: 800; font-size: 0.85rem; border: 1px solid rgba(243, 156, 18, 0.3);" title="Pendiente de extracción progresiva desde el portal NRE">
            ⏳ ${d.pendiente.toLocaleString('es-AR')}
          </span>
        </td>
        <td class="text-right" style="font-weight: 800;">
          <button class="btn btn-sm btn-ghost" onclick="openViewWithVehicleFilter('${r.filter}')" style="padding: 3px 10px; font-weight: 800; color: ${r.color}; border: 1px solid ${r.color}50; background: rgba(255,255,255,0.04); border-radius: 6px; cursor: pointer;" title="Filtrar cartera por ${r.name}">
            ${d.total.toLocaleString('es-AR')} →
          </button>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card mb-3" style="padding: 20px 22px; background: rgba(10, 25, 47, 0.85); border: 1px solid var(--border-color); border-radius: 14px; margin-bottom: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.88rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>🛡️</span> COBERTURA CONTRATADA POR TIPO DE VEHÍCULO (CARTERA ACTIVA)
          </div>
          <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 3px;">
            Distribución real auditada según cobertura (RC, Terceros B/B1, Terceros Completo C/C1) vs. pendientes de extracción.
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px; font-size: 0.75rem; flex-wrap: wrap;">
          <span style="background: rgba(46, 213, 115, 0.12); color: #2ed573; padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(46, 213, 115, 0.25); font-weight: 700;">
            ✓ Confirmadas: <strong>${totalConfirmadas.toLocaleString('es-AR')}</strong> (${pctConfirmadas}%)
          </span>
          <span style="background: rgba(243, 156, 18, 0.12); color: #f39c12; padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(243, 156, 18, 0.25); font-weight: 700;">
            ⏳ En Backfill: <strong>${totales.pendiente.toLocaleString('es-AR')}</strong> (${pctPendiente}%)
          </span>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.12);">
              <th style="font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px;">Tipo de Vehículo</th>
              <th class="text-center" style="font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px; color: #48cae4;">RC (Plan A)</th>
              <th class="text-center" style="font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px; color: #2ed573;">Planes B (Robo/Inc.)</th>
              <th class="text-center" style="font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px; color: #f1c40f;">Planes C (Terceros Compl.)</th>
              <th class="text-center" style="font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px; color: #f39c12; background: rgba(243, 156, 18, 0.08);">⏳ Pendiente / En Sync</th>
              <th class="text-right" style="font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.5px;">Total Activas</th>
            </tr>
          </thead>
          <tbody>
            ${trs}
          </tbody>
          <tfoot>
            <tr style="border-top: 2px solid rgba(0, 180, 216, 0.35); background: rgba(0, 180, 216, 0.06); font-weight: 800;">
              <td style="color: #48cae4; font-size: 0.88rem; font-weight: 800;">TOTAL CARTERA ACTIVA</td>
              <td class="text-center" style="color: #48cae4; font-size: 0.95rem;">${totales.rc.toLocaleString('es-AR')}</td>
              <td class="text-center" style="color: #2ed573; font-size: 0.95rem;">${totales.plan_b.toLocaleString('es-AR')}</td>
              <td class="text-center" style="color: #f1c40f; font-size: 0.95rem;">${totales.plan_c.toLocaleString('es-AR')}</td>
              <td class="text-center" style="color: #f39c12; font-size: 0.95rem; background: rgba(243, 156, 18, 0.08);">⏳ ${totales.pendiente.toLocaleString('es-AR')}</td>
              <td class="text-right" style="color: #fff; font-size: 1.05rem;">${totales.total.toLocaleString('es-AR')}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style="margin-top: 12px; display: flex; align-items: center; justify-content: space-between; font-size: 0.74rem; color: var(--text-secondary); flex-wrap: wrap; gap: 8px;">
        <span>ℹ️ <strong>Auditoría comercial:</strong> Motos y camiones se auditan individualmente sin asumir coberturas prefijadas. Los datos pasan a confirmados automáticamente en cada sincronización.</span>
        <span style="color: var(--accent-cyan-light);">🔄 Sincronización automática de 50 pólizas cada 2hs en horario hábil</span>
      </div>
    </div>
  `;
}

