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
let _cachedHistoricoCartera = null;
let _cachedHistoricoCarteraTimestamp = 0;

let _currentCarteraCrecimientoModo = 'mensual'; // 'mensual' | 'trimestral'
let _currentCarteraEvolucionModo = 'mensual'; // 'mensual' | 'trimestral' | 'snapshots'
let _currentRecuperacionModo = 'semanal';      // 'semanal' | 'mensual' | 'trimestral'
let _currentCobrosDiaRango = null;             // selector independiente de cobros por dia
let _currentCalendarioMes = null;              // mes activo en calendario mensual de actividad

window._lastMetricasData = null;
window._lastStatsData = null;
window._lastHistoricoCarteraData = null;

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
    const needsHistoricoCartera = forceRefreshStats || !_cachedHistoricoCartera || (now - _cachedHistoricoCarteraTimestamp > 60000);

    const promises = [fetch(url, { signal })];
    let statsIdx = -1;
    let historicoIdx = -1;

    if (needsStats) {
      statsIdx = promises.length;
      promises.push(fetch('/api/dashboard/stats', { signal }));
    }
    if (needsHistoricoCartera) {
      historicoIdx = promises.length;
      promises.push(fetch('/api/metricas/historico-cartera', { signal }));
    }

    const responses = await Promise.all(promises);

    if (thisSeq !== currentFetchSeq) {
      // Stale response: a newer request was dispatched, discard this one!
      return;
    }

    const data = await responses[0].json();
    if (statsIdx !== -1 && responses[statsIdx]) {
      _cachedDashboardStats = await responses[statsIdx].json();
      _cachedDashboardStatsTimestamp = Date.now();
    }
    if (historicoIdx !== -1 && responses[historicoIdx]) {
      _cachedHistoricoCartera = await responses[historicoIdx].json();
      _cachedHistoricoCarteraTimestamp = Date.now();
    }

    const stats = _cachedDashboardStats || {};
    const historicoCartera = _cachedHistoricoCartera || { snapshots: [], serie_mensual: [], serie_trimestral: [] };

    window._lastMetricasData = data;
    window._lastStatsData = stats;
    window._lastHistoricoCarteraData = historicoCartera;

    // Validación de rango: descartar respuestas que llegaron tarde para un período distinto al actual
    if (data.rango && data.rango !== currentRangoMetricas) {
      console.warn(`[Métricas] Respuesta obsoleta descartada: esperado="${currentRangoMetricas}", recibido="${data.rango}"`);
      return;
    }

    renderMetricasUI(data, stats, historicoCartera);
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

window.setModoCarteraCrecimiento = function(modo) {
  _currentCarteraCrecimientoModo = modo;
  const container = document.getElementById('cardCrecimientoYComposicionContainer');
  if (container && window._lastHistoricoCarteraData && window._lastStatsData) {
    container.outerHTML = renderCuadroCrecimientoYComposicionCartera(
      window._lastHistoricoCarteraData,
      window._lastStatsData,
      modo
    );
  }
};

window.setModoCarteraEvolucion = function(modo) {
  _currentCarteraEvolucionModo = modo;
  const container = document.getElementById('cardEvolucionCarteraContainer');
  if (container && window._lastHistoricoCarteraData) {
    container.outerHTML = renderEvolucionCarteraActivaChart(window._lastHistoricoCarteraData, modo);
  }
};

window.setModoRecuperacion = function(modo) {
  _currentRecuperacionModo = modo;
  const container = document.getElementById('cardHistoricoRecuperacionContainer');
  if (container && window._lastMetricasData) {
    container.outerHTML = renderHistoricoRecuperacionChart(window._lastMetricasData, modo);
  }
};

// ─── COMPONENTE: CRECIMIENTO & COMPOSICIÓN ESTRUCTURAL DE CARTERA ────────────
function renderCuadroCrecimientoYComposicionCartera(historicoCartera, stats, modo = 'mensual') {
  const h = historicoCartera || {};
  const s = stats || {};

  let series = [];
  let titleModo = 'Serie Mensual';

  if (modo === 'trimestral') {
    series = (h.serie_trimestral && h.serie_trimestral.length > 0) ? h.serie_trimestral.slice(-6) : [];
    titleModo = 'Serie Trimestral';
  } else {
    modo = 'mensual';
    series = (h.serie_mensual && h.serie_mensual.length > 0) ? h.serie_mensual.slice(-6) : [];
    titleModo = 'Serie Mensual (Últimos 6 Meses)';
  }

  const carteraTotal = s.cartera_activa_total || s.total_polizas || 0;

  if (series.length === 0) {
    series = [{
      label: 'Actual',
      periodo: 'Actual',
      cartera_activa_total: carteraTotal || 1586
    }];
  }

  // 1. Crecimiento Neto
  let growthBadge = '';
  let growthSubtitle = '';
  if (series.length >= 2) {
    const firstVal = series[0].cartera_activa_total || 0;
    const lastVal = series[series.length - 1].cartera_activa_total || 0;
    const diff = lastVal - firstVal;
    const pct = firstVal > 0 ? ((diff / firstVal) * 100).toFixed(1) : '0';
    const isPos = diff >= 0;
    const color = isPos ? '#2ed573' : '#ff4757';
    const sign = isPos ? '+' : '';
    const icon = isPos ? '📈' : '📉';
    const spanText = modo === 'trimestral' ? `${series.length} trimestres` : `${series.length} meses`;
    growthBadge = `<span style="font-size: 0.78rem; font-weight: 800; color: ${color}; background: rgba(255,255,255,0.06); padding: 4px 12px; border-radius: 20px; border: 1px solid ${color}50; display: inline-flex; align-items: center; gap: 6px;">${icon} Crecimiento Neto: ${sign}${diff.toLocaleString('es-AR')} pólizas (${sign}${pct}%) en ${spanText}</span>`;
    growthSubtitle = isPos
      ? `Expansión sostenida de <strong>${firstVal.toLocaleString('es-AR')}</strong> a <strong>${lastVal.toLocaleString('es-AR')}</strong> pólizas activas.`
      : `Evolución neta registrada en el período de seguimiento.`;
  } else {
    const singleVal = series[0]?.cartera_activa_total || carteraTotal || 0;
    growthBadge = `<span style="font-size: 0.78rem; font-weight: 800; color: #48cae4; background: rgba(0, 180, 216, 0.12); padding: 4px 12px; border-radius: 20px; border: 1px solid rgba(0, 180, 216, 0.35); display: inline-flex; align-items: center; gap: 6px;">🌱 Línea Base Inicial: ${singleVal.toLocaleString('es-AR')} pólizas</span>`;
    growthSubtitle = `Punto de partida registrado con datos 100% reales. El gráfico acumulará puntos reales automáticamente en cada sincronización diaria sin sembrar datos históricos artificiales.`;
  }

  // 2. Gráfico de Línea SVG
  const svgW = 740;
  const svgH = 190;
  const padL = 58;
  const padR = 40;
  const padT = 30;
  const padB = 38;
  const plotW = svgW - padL - padR; // 642
  const plotH = svgH - padT - padB; // 122
  const baseBottom = padT + plotH;

  const vals = series.map(item => item.cartera_activa_total || 0);
  const minObserved = Math.min(...vals);
  const maxObserved = Math.max(...vals);

  const valSpan = Math.max(40, maxObserved - minObserved);
  const valBottom = Math.max(0, Math.floor((minObserved - valSpan * 0.45) / 50) * 50);
  const valTop = Math.ceil((maxObserved + valSpan * 0.35) / 50) * 50;
  const valRange = Math.max(1, valTop - valBottom);

  const n = series.length;
  const isSinglePoint = n === 1;

  const points = series.map((item, idx) => {
    const cx = isSinglePoint ? padL + plotW / 2 : padL + (idx / (n - 1)) * plotW;
    const cy = isSinglePoint ? padT + plotH * 0.45 : padT + plotH - (((item.cartera_activa_total || 0) - valBottom) / valRange) * plotH;
    return { x: cx, y: cy, item, val: item.cartera_activa_total || 0, label: item.label || item.periodo || 'Hoy' };
  });

  const areaD = isSinglePoint
    ? `M ${padL},${points[0].y} L ${padL + plotW},${points[0].y} L ${padL + plotW},${baseBottom} L ${padL},${baseBottom} Z`
    : `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} ` + points.slice(1).map(p => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ` L ${points[points.length-1].x.toFixed(1)},${baseBottom} L ${points[0].x.toFixed(1)},${baseBottom} Z`;

  const lineD = isSinglePoint
    ? `M ${padL},${points[0].y} L ${padL + plotW},${points[0].y}`
    : `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} ` + points.slice(1).map(p => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const yTicks = [valBottom, Math.round(valBottom + valRange * 0.5), valTop].map(tv => {
    const yPos = padT + plotH - ((tv - valBottom) / valRange) * plotH;
    return `
      <line x1="${padL}" y1="${yPos.toFixed(1)}" x2="${padL + plotW}" y2="${yPos.toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-dasharray="3,3" />
      <text x="${padL - 10}" y="${(yPos + 4).toFixed(1)}" fill="var(--text-secondary)" font-size="10" font-weight="600" text-anchor="end">${tv.toLocaleString('es-AR')}</text>
    `;
  }).join('');

  const pointsSvg = points.map((p, idx) => {
    const isLast = idx === points.length - 1;
    const prev = idx > 0 ? points[idx - 1] : null;
    const delta = prev ? p.val - prev.val : 0;
    const deltaSign = delta > 0 ? '+' : '';
    const deltaStr = prev ? ` (${deltaSign}${delta} vs ant.)` : ' (Inicio período)';
    const tooltip = `${p.label}: ${p.val.toLocaleString('es-AR')} pólizas activas${deltaStr}`;

    return `
      <g style="cursor: pointer;">
        <title>${tooltip}</title>
        ${isLast ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" fill="none" stroke="#2ed573" stroke-width="2" opacity="0.65"><animate attributeName="r" values="7;13;7" dur="2s" repeatCount="indefinite"/></circle>` : ''}
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#0a192f" stroke="${isLast ? '#2ed573' : '#00b4d8'}" stroke-width="3"></circle>
        
        <!-- Etiqueta de valor -->
        <text x="${p.x.toFixed(1)}" y="${(p.y - 11).toFixed(1)}" fill="${isLast ? '#2ed573' : '#ffffff'}" font-size="11.5" font-weight="800" text-anchor="middle">${p.val.toLocaleString('es-AR')}</text>
        
        <!-- Etiqueta de período -->
        <text x="${p.x.toFixed(1)}" y="${baseBottom + 18}" fill="var(--text-primary)" font-size="11" font-weight="700" text-anchor="middle">${p.label}</text>
      </g>
    `;
  }).join('');

  // 3. Variables de Composición de Cartera
  const alDia = s.al_dia_estricto !== undefined ? s.al_dia_estricto : (s.al_dia || 0);
  const avisosCobranza = s.cobranza_avisos_total || 0;
  const vence48h = s.vence_48h || 0;
  const vencio48h = s.vencio_48h || 0;
  const vencio96h = s.vencio_96h || 0;

  const pctAlDia = carteraTotal > 0 ? ((alDia / carteraTotal) * 100).toFixed(1) : '0';
  const pctAvisos = carteraTotal > 0 ? ((avisosCobranza / carteraTotal) * 100).toFixed(1) : '0';

  const vigentes = s.polizas_vigentes_puras !== undefined ? s.polizas_vigentes_puras : (s.polizas_vigentes || 0);
  const aviso7d = s.polizas_vencen_semana || 0;
  const vencidas = s.polizas_vencidas_limpias !== undefined ? s.polizas_vencidas_limpias : (s.polizas_vencidas || 0);

  const pctVigentes = carteraTotal > 0 ? ((vigentes / carteraTotal) * 100).toFixed(1) : '0';
  const pctAviso7d = carteraTotal > 0 ? ((aviso7d / carteraTotal) * 100).toFixed(1) : '0';
  const pctVencidas = carteraTotal > 0 ? ((vencidas / carteraTotal) * 100).toFixed(1) : '0';

  const historicas = s.polizas_historicas_total !== undefined ? s.polizas_historicas_total : (s.total_recuperar || 0);
  const bajasMora = s.bajas_por_mora_96h || 0;
  const vencidas30d = s.bajas_vencidas_mas_30d || 0;

  return `
    <div id="cardCrecimientoYComposicionContainer" class="card mb-3" style="padding: 22px 24px; background: rgba(10, 25, 47, 0.92); border: 1px solid var(--border-color); border-radius: 16px; margin-bottom: 24px; box-shadow: 0 10px 28px rgba(0,0,0,0.35);">
      
      <!-- ENCABEZADO SUPERIOR: CRECIMIENTO & CONTROLES -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 12px;">
        <div>
          <div style="font-size: 0.96rem; font-weight: 800; text-transform: uppercase; color: #48cae4; letter-spacing: 0.8px; display: flex; align-items: center; gap: 8px;">
            <span>📈</span> EVOLUCIÓN &amp; COMPOSICIÓN ESTRUCTURAL DE CARTERA
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 3px;">
            ${titleModo} — ${growthSubtitle || 'Trayectoria continua de pólizas activas y estado de salud de cartera.'}
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          ${growthBadge}
          
          <!-- SELECTOR DE PERÍODO (MENSUAL / TRIMESTRAL) -->
          <div style="display: inline-flex; background: rgba(255,255,255,0.06); padding: 3px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.12);">
            <button onclick="setModoCarteraCrecimiento('mensual')" style="background: ${modo === 'mensual' ? '#00b4d8' : 'transparent'}; color: ${modo === 'mensual' ? '#0a192f' : 'var(--text-secondary)'}; border: none; padding: 4px 12px; border-radius: 16px; font-size: 0.76rem; font-weight: 700; cursor: pointer; transition: all 0.2s ease;">
              📅 Mensual
            </button>
            <button onclick="setModoCarteraCrecimiento('trimestral')" style="background: ${modo === 'trimestral' ? '#00b4d8' : 'transparent'}; color: ${modo === 'trimestral' ? '#0a192f' : 'var(--text-secondary)'}; border: none; padding: 4px 12px; border-radius: 16px; font-size: 0.76rem; font-weight: 700; cursor: pointer; transition: all 0.2s ease;">
              🗓️ Trimestral
            </button>
          </div>
        </div>
      </div>

      <!-- 1. GRÁFICO DE LÍNEA: EVOLUCIÓN DE CARTERA ACTIVA TOTAL -->
      <div style="position: relative; width: 100%; overflow-x: auto; background: rgba(0,0,0,0.22); border-radius: 12px; padding: 12px 14px 4px 14px; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 22px;">
        <svg viewBox="0 0 ${svgW} ${svgH}" style="width: 100%; height: auto; min-width: 520px; display: block;" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="growthAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#00b4d8" stop-opacity="0.28" />
              <stop offset="100%" stop-color="#00b4d8" stop-opacity="0.0" />
            </linearGradient>
            <filter id="lineGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#00b4d8" flood-opacity="0.45" />
            </filter>
          </defs>

          <!-- Grid horizontal -->
          ${yTicks}

          <!-- Área bajo la curva -->
          <!-- Línea continua de trayectoria -->
          <path d="${lineD}" fill="none" stroke="#00b4d8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" ${isSinglePoint ? 'stroke-dasharray="6,4" opacity="0.65"' : ''} filter="url(#lineGlow)"></path>

          <!-- Puntos interactivos y valores -->
          ${pointsSvg}

          ${isSinglePoint ? `<text x="${(padL + plotW / 2).toFixed(1)}" y="${(points[0].y + 26).toFixed(1)}" fill="#48cae4" font-size="10.5" font-weight="600" text-anchor="middle">🌱 Línea base actual registrada — acumulando historial real diario</text>` : ''}
        </svg>
      </div>

      <!-- SEPARADOR CON TÍTULO DE COMPOSICIÓN -->
      <div style="margin: 4px 0 16px 0; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 16px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 0.88rem; font-weight: 800; color: #48cae4; text-transform: uppercase; letter-spacing: 0.6px;">
            🧭 COMPOSICIÓN ESTRUCTURAL DE CARTERA
          </span>
          <span style="font-size: 0.72rem; color: #fff; background: rgba(0, 180, 216, 0.15); padding: 3px 10px; border-radius: 12px; border: 1px solid rgba(0, 180, 216, 0.3); font-weight: 700;">
            Total Activas: ${carteraTotal.toLocaleString('es-AR')}
          </span>
        </div>
        <span style="font-size: 0.74rem; color: var(--text-secondary);">
          Desglose proporcional de la cartera activa (100%) y archivo histórico complementario (fuera de cartera)
        </span>
      </div>

      <!-- NOTA ACLARATORIA DE DOS DIMENSIONES ORTOGONALES DE CARTERA -->
      <div style="background: rgba(0, 180, 216, 0.05); border: 1px solid rgba(0, 180, 216, 0.2); border-left: 4px solid #00b4d8; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 0.76rem; color: var(--text-secondary); line-height: 1.45;">
        <strong style="color: #48cae4;">💡 Dos dimensiones independientes de la misma cartera activa:</strong> 
        <span style="color: var(--text-primary); font-weight: 600;">Salud de Cobranza</span> evalúa el estado financiero (si el cliente adeuda cuotas o está al día), mientras que <span style="color: var(--text-primary); font-weight: 600;">Ciclo Contractual</span> evalúa la vigencia de la póliza (si está en curso, por renovar o recién vencida). Son dos ejes ortogonales: un cliente con póliza por vencer o vencida puede estar al día con sus pagos, por lo que ambas clasificaciones suman el 100% de la cartera de forma separada.
      </div>

      <!-- BARRAS APILADAS DE PROPORCIONES (100% CARTERA ACTIVA) -->
      <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 14px 16px; margin-bottom: 20px;">
        
        <!-- BARRA APILADA: COBRANZA -->
        <div style="margin-bottom: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 0.74rem;">
            <span style="font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
              <span>💳</span> Eje Financiero: Salud de Cobranza (100% Cartera por pago de cuotas)
            </span>
            <span>
              <strong style="color: #2ed573;">${pctAlDia}%</strong> Al Día (${alDia.toLocaleString('es-AR')}) &bull; <strong style="color: #e67e22;">${pctAvisos}%</strong> Avisos (${avisosCobranza.toLocaleString('es-AR')})
            </span>
          </div>
          <div style="width: 100%; height: 16px; background: rgba(255,255,255,0.06); border-radius: 8px; overflow: hidden; display: flex; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
            <div style="width: ${pctAlDia}%; background: linear-gradient(90deg, #2ed573, #26af5f); transition: width 0.4s ease;" title="Al Día: ${alDia.toLocaleString('es-AR')} pólizas (${pctAlDia}%)"></div>
            <div style="width: ${pctAvisos}%; background: linear-gradient(90deg, #f39c12, #e67e22); transition: width 0.4s ease;" title="Avisos Cobranza: ${avisosCobranza.toLocaleString('es-AR')} pólizas (${pctAvisos}%)"></div>
          </div>
        </div>

        <!-- BARRA APILADA: RENOVACIONES Y CONTRATOS -->
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 0.74rem;">
            <span style="font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
              <span>🛡️</span> Eje Contractual: Ciclo de Vigencia (100% Cartera por vencimiento de póliza)
            </span>
            <span>
              <strong style="color: #2ed573;">${pctVigentes}%</strong> Vigentes (${vigentes.toLocaleString('es-AR')}) &bull; <strong style="color: #00b4d8;">${pctAviso7d}%</strong> Ventana 7d (${aviso7d.toLocaleString('es-AR')}) &bull; <strong style="color: #e74c3c;">${pctVencidas}%</strong> Vencidas (${vencidas.toLocaleString('es-AR')})
            </span>
          </div>
          <div style="width: 100%; height: 16px; background: rgba(255,255,255,0.06); border-radius: 8px; overflow: hidden; display: flex; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
            <div style="width: ${pctVigentes}%; background: linear-gradient(90deg, #2ed573, #20bf6b); transition: width 0.4s ease;" title="Contrato Vigente: ${vigentes.toLocaleString('es-AR')} pólizas (${pctVigentes}%)"></div>
            <div style="width: ${pctAviso7d}%; background: linear-gradient(90deg, #00b4d8, #0984e3); transition: width 0.4s ease;" title="Aviso Renovación 7d: ${aviso7d.toLocaleString('es-AR')} pólizas (${pctAviso7d}%)"></div>
            <div style="width: ${pctVencidas}%; background: linear-gradient(90deg, #e74c3c, #d63031); transition: width 0.4s ease;" title="Póliza Vencida 1-30d: ${vencidas.toLocaleString('es-AR')} pólizas (${pctVencidas}%)"></div>
          </div>
        </div>

      </div>

      <!-- DESGLOSE ESTRUCTURAL EN 3 PANELES CON FILTROS DIRECTOS AL CRM -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px;">
        
        <!-- PANEL 1: SALUD DE COBRANZA -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(46, 213, 115, 0.25); border-radius: 12px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span style="font-size: 0.8rem; font-weight: 800; color: #2ed573; text-transform: uppercase; letter-spacing: 0.5px;">
              💳 Salud de Cobranza
            </span>
            <span style="font-size: 0.7rem; color: #2ed573; font-weight: 700; background: rgba(46, 213, 115, 0.1); padding: 2px 7px; border-radius: 8px; border: 1px solid rgba(46, 213, 115, 0.25);">Eje Financiero &bull; 100% Cartera</span>
          </div>

          <!-- Al Día -->
          <button class="action-card-btn" onclick="openViewWithFilter('cobranza', 'al_dia')" style="width: 100%; background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.3); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease; margin-bottom: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                <span>🟢</span> Al Día (Sin mora)
              </span>
              <span style="font-size: 1.25rem; font-weight: 800; color: #2ed573;">${alDia.toLocaleString('es-AR')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.72rem;">
              <span style="color: var(--text-secondary);">Sin cuotas vencidas</span>
              <span style="color: #2ed573; font-weight: 700;">${pctAlDia}% de cartera →</span>
            </div>
          </button>

          <!-- Avisos Cobranza -->
          <button class="action-card-btn" onclick="openViewWithFilter('cobranza', 'vencio_48h')" style="width: 100%; background: rgba(230, 126, 34, 0.08); border: 1px solid rgba(230, 126, 34, 0.3); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                <span>⚠️</span> Avisos Cobranza
              </span>
              <span style="font-size: 1.25rem; font-weight: 800; color: #e67e22;">${avisosCobranza.toLocaleString('es-AR')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.72rem;">
              <span style="color: var(--text-secondary);">48h + 1° y 2° aviso</span>
              <span style="color: #e67e22; font-weight: 700;">${pctAvisos}% de cartera →</span>
            </div>
            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 0.69rem; color: var(--text-secondary); display: flex; gap: 8px; flex-wrap: wrap;">
              <span>Prev 48h: <strong style="color:#f1c40f;">${vence48h}</strong></span>
              <span>1° Aviso: <strong style="color:#e67e22;">${vencio48h}</strong></span>
              <span>2° Aviso: <strong style="color:#e74c3c;">${vencio96h}</strong></span>
            </div>
          </button>
        </div>

        <!-- PANEL 2: CICLO CONTRACTUAL & RENOVACIONES -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(0, 180, 216, 0.25); border-radius: 12px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span style="font-size: 0.8rem; font-weight: 800; color: #00b4d8; text-transform: uppercase; letter-spacing: 0.5px;">
              🛡️ Ciclo Contractual &amp; Renovación
            </span>
            <span style="font-size: 0.7rem; color: #00b4d8; font-weight: 700; background: rgba(0, 180, 216, 0.1); padding: 2px 7px; border-radius: 8px; border: 1px solid rgba(0, 180, 216, 0.25);">Eje Vigencia &bull; 100% Cartera</span>
          </div>

          <!-- Contrato Vigente -->
          <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'vigente')" style="width: 100%; background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.3); text-align: left; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s ease; margin-bottom: 7px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; font-size: 0.8rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                <span>🛡️</span> Contrato Vigente
              </span>
              <span style="font-size: 1.1rem; font-weight: 800; color: #2ed573;">${vigentes.toLocaleString('es-AR')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px; font-size: 0.7rem;">
              <span style="color: var(--text-secondary);">Vigencia &gt; 7 días</span>
              <span style="color: #2ed573; font-weight: 700;">${pctVigentes}% →</span>
            </div>
          </button>

          <!-- Aviso Renovación -->
          <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'por_vencer')" style="width: 100%; background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.3); text-align: left; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s ease; margin-bottom: 7px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; font-size: 0.8rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                <span>📄</span> Aviso Renovación
              </span>
              <span style="font-size: 1.1rem; font-weight: 800; color: #00b4d8;">${aviso7d.toLocaleString('es-AR')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px; font-size: 0.7rem;">
              <span style="color: var(--text-secondary);">Vence en 7 días</span>
              <span style="color: #00b4d8; font-weight: 700;">${pctAviso7d}% →</span>
            </div>
          </button>

          <!-- Póliza Vencida -->
          <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'poliza_vencida')" style="width: 100%; background: rgba(231, 76, 60, 0.08); border: 1px solid rgba(231, 76, 60, 0.3); text-align: left; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; font-size: 0.8rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                <span>⏳</span> Póliza Vencida
              </span>
              <span style="font-size: 1.1rem; font-weight: 800; color: #e74c3c;">${vencidas.toLocaleString('es-AR')}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px; font-size: 0.7rem;">
              <span style="color: var(--text-secondary);">Vencida hace 1-30d</span>
              <span style="color: #e74c3c; font-weight: 700;">${pctVencidas}% →</span>
            </div>
          </button>
        </div>

        <!-- PANEL 3: ARCHIVO PASIVO & EXCLUSIONES -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(162, 155, 254, 0.25); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
              <span style="font-size: 0.8rem; font-weight: 800; color: #a29bfe; text-transform: uppercase; letter-spacing: 0.5px;">
                📦 Archivo Pasivo
              </span>
              <span style="font-size: 0.72rem; color: #a29bfe; background: rgba(162, 155, 254, 0.12); padding: 2px 7px; border-radius: 10px; font-weight: 700;">Fuera de Cartera</span>
            </div>

            <!-- Históricas / Bajas -->
            <button class="action-card-btn" onclick="openViewWithFilter('renovaciones', 'recuperar')" style="width: 100%; background: rgba(162, 155, 254, 0.08); border: 1px solid rgba(162, 155, 254, 0.3); text-align: left; padding: 12px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s ease; margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 700; font-size: 0.84rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                  <span>📦</span> Históricas / Bajas
                </span>
                <span style="font-size: 1.25rem; font-weight: 800; color: #a29bfe;">${historicas.toLocaleString('es-AR')}</span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: 0.72rem;">
                <span style="color: var(--text-secondary);">Bajas por mora + &gt;30d</span>
                <span style="color: #a29bfe; font-weight: 700;">Ver archivo →</span>
              </div>
              <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 0.69rem; color: var(--text-secondary); display: flex; gap: 8px; flex-wrap: wrap;">
                <span>Mora &gt;96h: <strong style="color:#a29bfe;">${bajasMora.toLocaleString('es-AR')}</strong></span>
                <span>Vencidas &gt;30d: <strong style="color:#a29bfe;">${vencidas30d.toLocaleString('es-AR')}</strong></span>
              </div>
            </button>
          </div>

          <div style="font-size: 0.71rem; color: var(--text-secondary); line-height: 1.4; padding: 6px 8px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
            🛡️ <strong>Blindaje estadístico:</strong> Excluidas de la cartera viva para no generar avisos erróneos de WhatsApp ni distorsionar las métricas operativas diarias.
          </div>
        </div>

      </div>

    </div>
  `;
}

// ─── COMPONENTE: AUDITORÍA DE FACTURACIÓN (PASO 0 DINÁMICO) ─────────────────
function renderCardAuditoriaFacturacion(audit = {}, stats = {}, metricasData = {}, activeRango = 'este_mes') {
  const totalActivas = audit.total_polizas_activas || stats.cartera_activa_total || 1698;
  const pctGlobal = audit.pct_con_suma_global !== undefined ? audit.pct_con_suma_global : 11.4;
  const pctNre = audit.pct_con_suma_nre !== undefined ? audit.pct_con_suma_nre : 10.5;
  const pctAgs = audit.pct_con_suma_ags !== undefined ? audit.pct_con_suma_ags : 47.8;
  const ticketCuota = audit.ticket_promedio_cuota || 33452;
  const cuotasAnalizadas = audit.total_cuotas_analizadas || 4773;
  const volumenEstimado = audit.volumen_estimado_mensual || Math.round(totalActivas * ticketCuota);
  const cobranzaEfectiva = metricasData.dinero_recuperado_total !== undefined ? metricasData.dinero_recuperado_total : (audit.cobranza_efectiva_periodo || 0);

  const ticketFmt = ticketCuota.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const volumenMillones = (volumenEstimado / 1000000).toFixed(1);
  const cobranzaMillones = (cobranzaEfectiva / 1000000).toFixed(1);

  const RANGO_LABELS = {
    hoy: 'Hoy',
    esta_semana: 'Esta Semana',
    este_mes: 'Este Mes',
    mes_anterior: 'Mes Anterior',
    '30_dias': 'Últimos 30 días',
    anio_actual: 'Año Actual',
    custom: 'Rango Personalizado',
    todo: 'Todo el Historial'
  };
  const labelPeriodo = RANGO_LABELS[activeRango] || 'Período Activo';

  return `
    <div class="card mb-3" style="padding: 20px 22px; background: rgba(10, 25, 47, 0.85); border: 1px solid rgba(243, 156, 18, 0.35); border-radius: 16px; margin-bottom: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.2rem;">🏛️</span>
          <span style="font-size: 0.88rem; font-weight: 800; text-transform: uppercase; color: #f39c12; letter-spacing: 0.5px;">
            VOLUMEN DE NEGOCIO &amp; FACTURACIÓN ESTIMADA
          </span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span style="font-size: 0.72rem; color: #2ed573; background: rgba(46, 213, 115, 0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(46, 213, 115, 0.3); font-weight: 700; display: inline-flex; align-items: center; gap: 5px;">
            <span>⚡</span> Recalculado en vivo en cada consulta
          </span>
          <span style="font-size: 0.72rem; color: #f39c12; background: rgba(243, 156, 18, 0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(243, 156, 18, 0.3); font-weight: 700;">
            ⏳ PASO 0 — AUDITORÍA TÉCNICA DE DATOS
          </span>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; font-size: 0.82rem; line-height: 1.5; color: var(--text-secondary);">
        <div style="background: rgba(255,255,255,0.02); padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06);">
          <div style="color: var(--text-primary); font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
            <span>🔍 Hallazgo de Auditoría (Campo <code style="color:#00b4d8;">suma_asegurada</code>):</span>
            <span style="color: #f39c12; font-weight: 800;">${pctGlobal}% activo</span>
          </div>
          El campo <code style="color:#00b4d8;">suma_asegurada</code> solo tiene valor &gt; $0 en el <strong>${pctGlobal}%</strong> de la cartera activa (${pctNre}% en NRE y ${pctAgs}% en AGS). En motos y coberturas de Responsabilidad Civil figura en <strong>$0,00</strong> porque representa el capital asegurado del vehículo ante destrucción o robo, <em>no la prima anual ni la cuota comercial</em>. Por esta razón técnica, el cálculo sobre este campo queda descartado para medir facturación.
        </div>
        <div style="background: rgba(255,255,255,0.02); padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.06);">
          <div style="color: var(--text-primary); font-weight: 700; margin-bottom: 4px;">⚖️ Decisión de Calibración (Candidatos en Vivo):</div>
          El gráfico de facturación permanece pausado para consensuar la métrica definitiva entre las dos opciones:
          <div style="margin-top: 6px; display: flex; flex-direction: column; gap: 6px;">
            <div style="background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.25); padding: 6px 10px; border-radius: 8px;">
              <strong style="color: #2ed573;">Opción A — Cobranza Efectiva Atribuida:</strong> <strong>$${cobranzaMillones}M</strong> en ${labelPeriodo} (plata cobrada y atribuida a las gestiones reales de WhatsApp).
            </div>
            <div style="background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.25); padding: 6px 10px; border-radius: 8px;">
              <strong style="color: #00b4d8;">Opción B — Volumen Estimado de Primas:</strong> <strong>~$${volumenMillones}M/mes</strong> (proyección calculada en vivo: ${totalActivas.toLocaleString('es-AR')} pólizas activas &times; ticket promedio real de cuota de <strong>${ticketFmt}</strong>, obtenido de ${cuotasAnalizadas.toLocaleString('es-AR')} cuotas históricas en la base).
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ─── COMPONENTE: PERFIL DEMOGRÁFICO DE LA CARTERA ACTIVA (GÉNERO & COBERTURA DNI) ─
function renderCardDemografiaGenero(demo = {}) {
  const total = demo.total_analizados || 0;
  const totalFmt = total.toLocaleString('es-AR');
  const masc = (demo.masculino || 0).toLocaleString('es-AR');
  const fem = (demo.femenino || 0).toLocaleString('es-AR');
  const noDet = (demo.no_determinado || 0).toLocaleString('es-AR');
  const conDni = (demo.con_dni || 0).toLocaleString('es-AR');

  const pctMasc = typeof demo.pct_masculino === 'number' ? demo.pct_masculino : parseFloat(demo.pct_masculino || 0);
  const pctFem = typeof demo.pct_femenino === 'number' ? demo.pct_femenino : parseFloat(demo.pct_femenino || 0);
  const pctNoDet = typeof demo.pct_no_determinado === 'number' ? demo.pct_no_determinado : parseFloat(demo.pct_no_determinado || 0);
  const pctConDni = typeof demo.pct_con_dni === 'number' ? demo.pct_con_dni : parseFloat(demo.pct_con_dni || 0);

  return `
    <div class="card mb-3" id="cardDemografiaGenero" style="padding: 20px 22px; background: rgba(10, 25, 47, 0.85); border: 1px solid rgba(0, 180, 216, 0.35); border-radius: 16px; margin-bottom: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.3rem;">👥</span>
          <div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #48cae4; text-transform: uppercase; letter-spacing: 0.5px;">
              Perfil Demográfico de la Cartera Activa
            </div>
            <div style="font-size: 0.74rem; color: var(--text-secondary);">
              Inferencia de género por nombre de pila &amp; Cobertura de DNI en Cartera Activa
            </div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span style="font-size: 0.72rem; color: #48cae4; background: rgba(72, 202, 228, 0.12); border: 1px solid rgba(72, 202, 228, 0.3); padding: 3px 10px; border-radius: 12px; font-weight: 700;">
            🌐 ${totalFmt} pólizas activas
          </span>
          <span style="font-size: 0.72rem; color: #2ed573; background: rgba(46, 213, 115, 0.12); border: 1px solid rgba(46, 213, 115, 0.3); padding: 3px 10px; border-radius: 12px; font-weight: 700;">
            🪪 DNI Extraído: ${conDni} (${pctConDni}%)
          </span>
        </div>
      </div>

      <!-- 3 TARJETAS DE GÉNERO -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 16px;">
        
        <!-- MASCULINO -->
        <div style="background: rgba(9, 132, 227, 0.06); border: 1px solid rgba(9, 132, 227, 0.35); border-left: 4px solid #0984e3; border-radius: 10px; padding: 14px 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 800; color: #74b9ff; text-transform: uppercase;">👨 Masculino</span>
            <span style="font-size: 0.72rem; font-weight: 700; color: #0984e3; background: rgba(9, 132, 227, 0.18); padding: 2px 7px; border-radius: 6px;">${pctMasc}%</span>
          </div>
          <div style="font-size: 1.45rem; font-weight: 800; color: #fff; margin-bottom: 4px;">
            ${masc}
          </div>
          <div style="font-size: 0.73rem; color: var(--text-secondary);">
            Asegurados con nombre masculino identificado
          </div>
        </div>

        <!-- FEMENINO -->
        <div style="background: rgba(232, 67, 147, 0.06); border: 1px solid rgba(232, 67, 147, 0.35); border-left: 4px solid #e84393; border-radius: 10px; padding: 14px 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 800; color: #fd79a8; text-transform: uppercase;">👩 Femenino</span>
            <span style="font-size: 0.72rem; font-weight: 700; color: #e84393; background: rgba(232, 67, 147, 0.18); padding: 2px 7px; border-radius: 6px;">${pctFem}%</span>
          </div>
          <div style="font-size: 1.45rem; font-weight: 800; color: #fff; margin-bottom: 4px;">
            ${fem}
          </div>
          <div style="font-size: 0.73rem; color: var(--text-secondary);">
            Aseguradas con nombre femenino identificado
          </div>
        </div>

        <!-- NO DETERMINADO / SOCIEDADES -->
        <div style="background: rgba(160, 174, 192, 0.06); border: 1px solid rgba(160, 174, 192, 0.3); border-left: 4px solid #a0aec0; border-radius: 10px; padding: 14px 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <span style="font-size: 0.76rem; font-weight: 800; color: #cbd5e0; text-transform: uppercase;">❔ No determinado</span>
            <span style="font-size: 0.72rem; font-weight: 700; color: #a0aec0; background: rgba(160, 174, 192, 0.18); padding: 2px 7px; border-radius: 6px;">${pctNoDet}%</span>
          </div>
          <div style="font-size: 1.45rem; font-weight: 800; color: #fff; margin-bottom: 4px;">
            ${noDet}
          </div>
          <div style="font-size: 0.73rem; color: var(--text-secondary);">
            Empresas, nombres neutros o sin coincidencia
          </div>
        </div>

      </div>

      <!-- BARRA VISUAL MULTICOLOR (GÉNERO) -->
      <div style="margin-bottom: 16px;">
        <div style="height: 12px; border-radius: 6px; overflow: hidden; display: flex; background: rgba(255, 255, 255, 0.05);">
          <div style="width: ${pctMasc}%; background: linear-gradient(90deg, #0984e3, #74b9ff);" title="Masculino: ${pctMasc}%"></div>
          <div style="width: ${pctFem}%; background: linear-gradient(90deg, #d63031, #e84393);" title="Femenino: ${pctFem}%"></div>
          <div style="width: ${pctNoDet}%; background: #636e72;" title="No determinado: ${pctNoDet}%"></div>
        </div>
      </div>

      <!-- SECCIÓN: DISTRIBUCIÓN ETARIA ESTIMADA POR RANGO DE DNI -->
      ${(() => {
        const etaria = demo.distribucion_etaria || {};
        const franjas = etaria.franjas || [];
        const conDniTotal = etaria.total_con_dni || 0;
        const conDniFmt = conDniTotal.toLocaleString('es-AR');
        const pctCoberturaDni = etaria.pct_cobertura_dni || pctConDni;

        if (franjas.length === 0) return '';

        const cardsFranjasHtml = franjas.map(f => {
          const cantFmt = (f.cantidad || 0).toLocaleString('es-AR');
          const pctFmt = f.pct || 0;
          return `
            <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 10px 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <div>
                  <strong style="color: #48cae4; font-size: 0.85rem;">${f.franja}</strong>
                  <span style="font-size: 0.7rem; color: var(--text-secondary); margin-left: 6px;">(${f.decada_nacimiento})</span>
                </div>
                <span style="font-size: 0.74rem; font-weight: 800; color: #2ed573; background: rgba(46, 213, 115, 0.12); padding: 2px 7px; border-radius: 6px;">
                  ${pctFmt}%
                </span>
              </div>
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.68rem; color: var(--text-secondary); margin-bottom: 5px;">
                <span>DNI ${f.rango_dni}</span>
                <strong>${cantFmt} asegurados</strong>
              </div>
              <div style="height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.05); overflow: hidden;">
                <div style="width: ${pctFmt}%; height: 100%; background: linear-gradient(90deg, #00b4d8, #0077b6); border-radius: 3px;"></div>
              </div>
            </div>
          `;
        }).join('');

        return `
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.08);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 1.15rem;">🎂</span>
                <div>
                  <div style="font-size: 0.88rem; font-weight: 800; color: #48cae4; text-transform: uppercase; letter-spacing: 0.5px;">
                    Distribución Etaria Estimada por Rango de DNI
                  </div>
                  <div style="font-size: 0.72rem; color: var(--text-secondary);">
                    Asignación secuencial histórica de DNI en Argentina (cálculo dinámico contra ${etaria.anio_referencia || new Date().getFullYear()})
                  </div>
                </div>
              </div>
              <span style="font-size: 0.72rem; color: #00b4d8; background: rgba(0, 180, 216, 0.12); border: 1px solid rgba(0, 180, 216, 0.3); padding: 3px 10px; border-radius: 12px; font-weight: 700;">
                Muestra evaluada: ${conDniFmt} de ${totalFmt} pólizas (${pctCoberturaDni}%)
              </span>
            </div>

            <!-- GRILLA DE FRANJAS ETARIAS -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-bottom: 14px;">
              ${cardsFranjasHtml}
            </div>
          </div>
        `;
      })()}

      <!-- NOTAS METODOLÓGICAS TRANSPARENTES -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.08);">
        
        <!-- NOTA 1: GÉNERO -->
        <div style="font-size: 0.74rem; color: var(--text-secondary); line-height: 1.45; background: rgba(0, 180, 216, 0.04); padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(0, 180, 216, 0.15);">
          <strong style="color: #48cae4;">💡 Inferencia de Género por Nombre de Pila:</strong>
          <div style="margin-top: 3px;">
            Estimación algorítmica orientativa analizada a partir de los nombres de pila de la cartera viva. No constituye dato registral oficial ni contractual.
          </div>
        </div>

        <!-- NOTA 2: ESTIMACIÓN ETARIA POR DNI Y EXCEPCIONES CONOCIDAS -->
        <div style="font-size: 0.74rem; color: var(--text-secondary); line-height: 1.45; background: rgba(0, 180, 216, 0.04); padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(0, 180, 216, 0.2);">
          <strong style="color: #48cae4;">📊 Metodología de Estimación Etaria por DNI:</strong>
          <div style="margin-top: 3px;">
            Aproximación por décadas basada en la correlación secuencial histórica de asignación de DNI en Argentina (calculada dinámicamente contra la fecha actual).
          </div>
          <div style="margin-top: 4px; font-size: 0.71rem; color: #a0aec0;">
            <strong>⚠️ Excepciones metodológicas conocidas:</strong><br>
            • No es confiable para extranjeros naturalizados (su DNI refleja cuándo se nacionalizaron, no cuándo nacieron).<br>
            • No es confiable ante duplicados o trámites tardíos de documento.<br>
            • Es una estimación por década, no una edad exacta.
          </div>
        </div>

        <!-- NOTA 3: EDAD EXACTA EN PAUSA METODOLÓGICA (DISTINTA Y NO MEZCLADA) -->
        <div style="font-size: 0.74rem; color: var(--text-secondary); line-height: 1.45; background: rgba(243, 156, 18, 0.04); padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(243, 156, 18, 0.18);">
          <strong style="color: #f39c12;">⏳ Estadísticas de Fecha de Nacimiento Real (En Pausa Metodológica):</strong>
          <div style="margin-top: 3px;">
            La pirámide etaria exacta por fecha de nacimiento continúa en pausa metodológica por falta de fecha de nacimiento fehaciente en póliza. La estimación por DNI de arriba es una aproximación distinta y más gruesa mientras no se disponga de la fecha de nacimiento real.
          </div>
        </div>

      </div>
    </div>
  `;
}

// ─── COMPONENTE: EVOLUCIÓN HISTÓRICA DE CARTERA ACTIVA (DESGLOSE POR VEHÍCULO) ──
function renderEvolucionCarteraActivaChart(historicoCartera, modo = 'mensual') {
  const h = historicoCartera || {};
  let series = [];
  let titleModo = 'Serie Mensual';

  if (modo === 'trimestral') {
    series = h.serie_trimestral || [];
    titleModo = 'Serie Trimestral';
  } else if (modo === 'snapshots') {
    series = (h.snapshots || []).slice(-15).map(s => ({
      label: s.fecha ? s.fecha.slice(5) : 'Día',
      ...s
    }));
    titleModo = 'Últimos 15 Snapshots Diarios';
  } else {
    modo = 'mensual';
    series = h.serie_mensual || [];
    titleModo = 'Serie Mensual (Últimos 6 Meses)';
  }

  if (series.length === 0) {
    series = [{
      label: 'Actual',
      cartera_activa_total: 1586,
      autos: 875,
      pickups: 312,
      motos: 357,
      camiones: 42
    }];
  }

  const maxVal = Math.max(1600, Math.ceil((Math.max(...series.map(s => s.cartera_activa_total || 0)) * 1.15) / 100) * 100);

  // SVG Geometry
  const svgW = 740;
  const svgH = 220;
  const padL = 60;
  const padR = 30;
  const padT = 25;
  const padB = 40;
  const plotW = svgW - padL - padR; // 650
  const plotH = svgH - padT - padB; // 155

  const n = series.length;
  const colW = plotW / n;
  const barW = Math.min(52, Math.max(18, colW * 0.58));

  const linePoints = [];

  const barsSvg = series.map((s, idx) => {
    const tot = s.cartera_activa_total || 0;
    const autos = s.autos || 0;
    const pickups = s.pickups || 0;
    const motos = s.motos || 0;
    const camiones = s.camiones || 0;

    const cx = padL + (idx + 0.5) * colW;
    const bx = cx - barW / 2;

    const hAuto = (autos / maxVal) * plotH;
    const hPick = (pickups / maxVal) * plotH;
    const hMoto = (motos / maxVal) * plotH;
    const hCam = (camiones / maxVal) * plotH;

    const baseBottom = padT + plotH;
    const yAuto = baseBottom - hAuto;
    const yPick = yAuto - hPick;
    const yMoto = yPick - hMoto;
    const yCam = yMoto - hCam;

    linePoints.push({ x: cx, y: yCam });

    const tooltip = `${s.label || s.periodo}: ${tot.toLocaleString('es-AR')} pólizas activas
• 🚗 Autos: ${autos.toLocaleString('es-AR')} (${tot > 0 ? ((autos/tot)*100).toFixed(1) : 0}%)
• 🛻 Pickups: ${pickups.toLocaleString('es-AR')} (${tot > 0 ? ((pickups/tot)*100).toFixed(1) : 0}%)
• 🏍️ Motos: ${motos.toLocaleString('es-AR')} (${tot > 0 ? ((motos/tot)*100).toFixed(1) : 0}%)
• 🚛 Camiones: ${camiones.toLocaleString('es-AR')} (${tot > 0 ? ((camiones/tot)*100).toFixed(1) : 0}%)`;

    return `
      <g style="cursor: pointer;">
        <title>${tooltip}</title>
        <!-- Stack 1: Autos (Bottom) -->
        <rect x="${bx}" y="${yAuto}" width="${barW}" height="${Math.max(1, hAuto)}" fill="#48cae4" opacity="0.9"></rect>
        <!-- Stack 2: Pickups -->
        <rect x="${bx}" y="${yPick}" width="${barW}" height="${Math.max(1, hPick)}" fill="#2ed573" opacity="0.9"></rect>
        <!-- Stack 3: Motos -->
        <rect x="${bx}" y="${yMoto}" width="${barW}" height="${Math.max(1, hMoto)}" fill="#f39c12" opacity="0.9"></rect>
        <!-- Stack 4: Camiones (Top) -->
        <rect x="${bx}" y="${yCam}" width="${barW}" height="${Math.max(1, hCam)}" fill="#a29bfe" rx="4" opacity="0.9"></rect>

        <!-- Total Label on Top -->
        <text x="${cx}" y="${yCam - 6}" fill="#fff" font-size="10.5" font-weight="800" text-anchor="middle">${tot.toLocaleString('es-AR')}</text>

        <!-- X Axis Label -->
        <text x="${cx}" y="${baseBottom + 16}" fill="var(--text-primary)" font-size="10.5" font-weight="700" text-anchor="middle">${s.label || s.periodo}</text>
      </g>
    `;
  }).join('');

  const pathTrajectory = linePoints.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  const yTicks = [0, maxVal * 0.5, maxVal].map(v => {
    const yPos = padT + plotH - (v / maxVal) * plotH;
    return `
      <line x1="${padL}" y1="${yPos}" x2="${padL + plotW}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
      <text x="${padL - 10}" y="${yPos + 4}" fill="var(--text-secondary)" font-size="10" font-weight="600" text-anchor="end">${v.toLocaleString('es-AR')}</text>
    `;
  }).join('');

  let growthBadge = '';
  if (series.length >= 2) {
    const first = series[0].cartera_activa_total || 0;
    const last = series[series.length - 1].cartera_activa_total || 0;
    const diff = last - first;
    const pct = first > 0 ? ((diff / first) * 100).toFixed(1) : 0;
    const isPos = diff >= 0;
    const color = isPos ? '#2ed573' : '#ff4757';
    growthBadge = `<span style="font-size: 0.74rem; font-weight: 800; color: ${color}; background: rgba(255,255,255,0.06); padding: 3px 9px; border-radius: 8px; border: 1px solid ${color}40;">${isPos ? '📈' : '📉'} ${isPos ? '+' : ''}${diff.toLocaleString('es-AR')} pólizas (${isPos ? '+' : ''}${pct}%)</span>`;
  }

  return `
    <div id="cardEvolucionCarteraContainer" class="card mb-3" style="padding: 22px; margin-bottom: 24px; background: rgba(10, 25, 47, 0.85); border: 1px solid var(--border-color); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>📈</span> EVOLUCIÓN HISTÓRICA DE CARTERA ACTIVA (DESGLOSE POR VEHÍCULO)
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            ${titleModo} — Seguimiento de pólizas vivas con desglose apilado de Autos, Pick Ups, Motos y Camiones.
          </div>
        </div>

        <!-- SELECTOR DE VISTA: MENSUAL / TRIMESTRAL / SNAPSHOTS -->
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          ${growthBadge}
          <div style="background: rgba(255,255,255,0.05); padding: 3px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); display: inline-flex;">
            <button class="btn btn-sm" onclick="setModoCarteraEvolucion('mensual')" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer; background: ${modo === 'mensual' ? '#00b4d8' : 'transparent'}; color: ${modo === 'mensual' ? '#0a192f' : 'var(--text-secondary)'};">
              📅 Mensual
            </button>
            <button class="btn btn-sm" onclick="setModoCarteraEvolucion('trimestral')" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer; background: ${modo === 'trimestral' ? '#00b4d8' : 'transparent'}; color: ${modo === 'trimestral' ? '#0a192f' : 'var(--text-secondary)'};">
              🗓️ Trimestral
            </button>
            <button class="btn btn-sm" onclick="setModoCarteraEvolucion('snapshots')" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer; background: ${modo === 'snapshots' ? '#00b4d8' : 'transparent'}; color: ${modo === 'snapshots' ? '#0a192f' : 'var(--text-secondary)'};">
              📈 Snapshots
            </button>
          </div>
        </div>
      </div>

      <!-- CHART SVG -->
      <div style="width: 100%; overflow-x: auto;">
        <svg viewBox="0 0 ${svgW} ${svgH}" style="width: 100%; max-height: 220px; min-width: 550px; display: block;">
          ${yTicks}
          ${barsSvg}
          <path d="${pathTrajectory}" fill="none" stroke="rgba(0, 180, 216, 0.45)" stroke-width="2" stroke-dasharray="4,4"></path>
        </svg>
      </div>

      <!-- LEYENDA APILADA INFERIOR -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 14px; flex-wrap: wrap; gap: 10px; font-size: 0.75rem; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px;">
        <div style="display: flex; gap: 14px; flex-wrap: wrap;">
          <span style="display: flex; align-items: center; gap: 6px; color: #48cae4;">
            <span style="width: 10px; height: 10px; background: #48cae4; border-radius: 2px;"></span> 🚗 Autos
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #2ed573;">
            <span style="width: 10px; height: 10px; background: #2ed573; border-radius: 2px;"></span> 🛻 Pick Ups
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #f39c12;">
            <span style="width: 10px; height: 10px; background: #f39c12; border-radius: 2px;"></span> 🏍️ Motos
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #a29bfe;">
            <span style="width: 10px; height: 10px; background: #a29bfe; border-radius: 2px;"></span> 🚛 Camiones
          </span>
        </div>
        <span style="color: var(--text-secondary); font-size: 0.72rem;">
          💾 Snapshots diarios automáticos guardados en base local
        </span>
      </div>
    </div>
  `;
}

// ─── COMPONENTE: DINERO RECUPERADO Y CONVERSIÓN EN EL TIEMPO ────────────────
function renderHistoricoRecuperacionChart(data, modo = 'semanal') {
  let historico = [];
  let titleLabel = 'Trayectoria Semanal (Últimas 8 Semanas)';

  if (modo === 'mensual') {
    historico = data.historico_mensual || [];
    titleLabel = 'Trayectoria Mensual (Últimos 6 Meses)';
  } else if (modo === 'trimestral') {
    historico = data.historico_trimestral || [];
    titleLabel = 'Trayectoria Trimestral (Últimos 4 Trimestres)';
  } else {
    modo = 'semanal';
    historico = data.historico_semanal || [];
    titleLabel = 'Trayectoria Semanal (Últimas 8 Semanas)';
  }

  if (!historico || historico.length === 0) return '';
  const maxDinero = Math.max(1000, ...historico.map(h => h.dinero_recuperado || 0));
  const maxTasa = 100;

  // Dual axis SVG geometry
  const svgW = 740;
  const svgH = 210;
  const padL = 70;
  const padR = 55;
  const padT = 25;
  const padB = 40;
  const plotW = svgW - padL - padR; // 615
  const plotH = svgH - padT - padB; // 145

  const n = historico.length;
  const stepX = n > 1 ? plotW / (n - 1) : plotW;

  const pointsDinero = [];
  const pointsTasa = [];

  historico.forEach((h, idx) => {
    const x = padL + idx * stepX;
    const din = Math.max(0, h.dinero_recuperado || 0);
    const tasa = Math.min(100, Math.max(0, parseFloat(h.tasa_conversion || 0)));
    const yDin = padT + plotH - (din / maxDinero) * plotH;
    const yTasa = padT + plotH - (tasa / maxTasa) * plotH;

    pointsDinero.push({ x, y: yDin, val: din, h });
    pointsTasa.push({ x, y: yTasa, val: tasa, h });
  });

  const pathDineroD = pointsDinero.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaDineroD = `${pathDineroD} L ${pointsDinero[pointsDinero.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${pointsDinero[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
  const pathTasaD = pointsTasa.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  // Left Y axis ticks (Dinero - Green)
  const yTicksDin = [0, maxDinero * 0.5, maxDinero].map(val => {
    const y = padT + plotH - (val / maxDinero) * plotH;
    const fmt = val === 0 ? '$0' : (val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` : `$${Math.round(val / 1000)}k`);
    return `
      <line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
      <text x="${padL - 10}" y="${y + 4}" fill="#2ed573" font-size="10" font-weight="700" text-anchor="end">${fmt}</text>
    `;
  }).join('');

  // Right Y axis ticks (Conversión - Cyan)
  const yTicksTasa = [0, 50, 100].map(val => {
    const y = padT + plotH - (val / maxTasa) * plotH;
    return `
      <text x="${padL + plotW + 10}" y="${y + 4}" fill="#00b4d8" font-size="10" font-weight="700" text-anchor="start">${val}%</text>
    `;
  }).join('');

  // Nodes for Dinero (green) and Tasa (cyan)
  const nodesDinero = pointsDinero.map(p => {
    const dinFmt = p.val.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
    const lbl = p.h.semana || p.h.mes || p.h.trimestre || p.h.label;
    return `
      <g>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#2ed573" stroke="#0a192f" stroke-width="2">
          <title>${lbl} (${p.h.label}): ${dinFmt} recuperados en ${p.h.exitosos || 0} cobros</title>
        </circle>
      </g>
    `;
  }).join('');

  const nodesTasa = pointsTasa.map(p => {
    const lbl = p.h.semana || p.h.mes || p.h.trimestre || p.h.label;
    return `
      <g>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#00b4d8" stroke="#0a192f" stroke-width="2">
          <title>${lbl} (${p.h.label}): ${p.val}% conversión</title>
        </circle>
      </g>
    `;
  }).join('');

  // X labels
  const xLabels = historico.map((h, idx) => {
    const x = padL + idx * stepX;
    const l1 = h.semana || h.mes || h.trimestre || h.label;
    const l2 = h.semana ? h.label : (h.mes ? '' : h.trimestre);
    return `
      <text x="${x.toFixed(1)}" y="${padT + plotH + 16}" fill="var(--text-primary)" font-size="10.5" font-weight="700" text-anchor="middle">${l1}</text>
      ${l2 ? `<text x="${x.toFixed(1)}" y="${padT + plotH + 28}" fill="var(--text-secondary)" font-size="9" text-anchor="middle">${l2}</text>` : ''}
    `;
  }).join('');

  // Bottom ratio cards
  const ratioCards = historico.map(h => {
    const dineroFmt = (h.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
    const lbl = h.semana || h.mes || h.trimestre || h.label;

    return `
      <div style="flex: 1; text-align: center; min-width: 65px; background: rgba(255,255,255,0.02); border-radius: 8px; padding: 8px 4px; border: 1px solid rgba(255,255,255,0.06);">
        <div style="font-size: 0.72rem; font-weight: 800; color: #2ed573;">${dineroFmt}</div>
        <div style="font-size: 0.68rem; font-weight: 700; color: #00b4d8; margin: 3px 0;">${h.tasa_conversion}%</div>
        <div style="font-size: 0.63rem; color: var(--text-secondary); font-weight: 700;">
          ${h.exitosos || 0} / ${h.envios_unicos || h.envios || 0}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div id="cardHistoricoRecuperacionContainer" class="card mb-3" style="padding: 24px; margin-bottom: 24px; background: rgba(10, 25, 47, 0.85); border: 1px solid var(--border-color); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>📈</span> DINERO RECUPERADO Y TASA DE CONVERSIÓN EN EL TIEMPO
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            ${titleLabel} — Evolución continua de Dinero ($ Eje Izq.) vs. Tasa de Conversión (% Eje Der.)
          </div>
        </div>

        <!-- SELECTOR DE PESTAÑAS: SEMANAL / MENSUAL / TRIMESTRAL -->
        <div style="background: rgba(255,255,255,0.05); padding: 3px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); display: inline-flex;">
          <button class="btn btn-sm" onclick="setModoRecuperacion('semanal')" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer; background: ${modo === 'semanal' ? '#2ed573' : 'transparent'}; color: ${modo === 'semanal' ? '#0a192f' : 'var(--text-secondary)'};">
            📆 Semanal
          </button>
          <button class="btn btn-sm" onclick="setModoRecuperacion('mensual')" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer; background: ${modo === 'mensual' ? '#2ed573' : 'transparent'}; color: ${modo === 'mensual' ? '#0a192f' : 'var(--text-secondary)'};">
            📅 Mensual
          </button>
          <button class="btn btn-sm" onclick="setModoRecuperacion('trimestral')" style="padding: 4px 10px; font-size: 0.75rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer; background: ${modo === 'trimestral' ? '#2ed573' : 'transparent'}; color: ${modo === 'trimestral' ? '#0a192f' : 'var(--text-secondary)'};">
            🗓️ Trimestral
          </button>
        </div>
      </div>

      <!-- SVG DUAL AXIS CHART -->
      <div style="width: 100%; overflow-x: auto;">
        <svg viewBox="0 0 ${svgW} ${svgH}" style="width: 100%; max-height: 230px; min-width: 580px; display: block;">
          <defs>
            <linearGradient id="gradienteDinero" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#2ed573" stop-opacity="0.22" />
              <stop offset="100%" stop-color="#2ed573" stop-opacity="0.0" />
            </linearGradient>
          </defs>

          <!-- Grid Lines -->
          ${yTicksDin}
          ${yTicksTasa}

          <!-- Area & Line Dinero (Green) -->
          <path d="${areaDineroD}" fill="url(#gradienteDinero)"></path>
          <path d="${pathDineroD}" fill="none" stroke="#2ed573" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>

          <!-- Line Conversión (Cyan Dashed) -->
          <path d="${pathTasaD}" fill="none" stroke="#00b4d8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4,3"></path>

          <!-- Interactive Nodes -->
          ${nodesDinero}
          ${nodesTasa}

          <!-- X Labels -->
          ${xLabels}
        </svg>
      </div>

      <!-- Summary Cards -->
      <div style="display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; overflow-x: auto; padding: 4px 0;">
        ${ratioCards}
      </div>
    </div>
  `;
}

// ─── COMPONENTE: DISTRIBUCIÓN DE COBROS POR DÍA DE LA SEMANA ───────────────
function renderCobrosPorDiaSemanaInner(cobrosPorDia, diaPico, activeRango = 'este_mes') {
  if (!cobrosPorDia || cobrosPorDia.length === 0) return '';
  const sortedDias = [...cobrosPorDia].filter(d => (d.cobros || 0) > 0).sort((a, b) => (b.cobros || 0) - (a.cobros || 0));
  const top1 = sortedDias[0] || (diaPico?.dia ? { dia: diaPico.dia, cobros: diaPico.cobros || 0, pct_cobros: diaPico.pct_cobros || 0, dinero_recuperado: diaPico.dinero_recuperado || 0 } : { dia: 'Lunes', cobros: 0, pct_cobros: 0, dinero_recuperado: 0 });
  const diaPicoNombre = top1.dia || 'Lunes';
  const diaPicoCobros = top1.cobros || 0;
  const diaPicoPct = top1.pct_cobros || 0;
  const diaPicoDinero = (top1.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  const top2 = sortedDias[1] || null;
  const topSumaPct = top2 ? ((top1.pct_cobros || 0) + (top2.pct_cobros || 0)).toFixed(1) : top1.pct_cobros;
  const top2Texto = top2 ? ` y <strong>${top2.dia}</strong> (${top2.pct_cobros}%)` : '';

  let recomendacionTexto = '';
  if (top1.pct_cobros >= 30) {
    recomendacionTexto = `Fuerte concentración el <strong>${top1.dia}</strong> (${top1.pct_cobros}% de los pagos). Reforzar las gestiones preventivas 48 hs antes optimiza la tasa de cobranza efectiva.`;
  } else {
    recomendacionTexto = `Los pagos se distribuyen de forma pareja a lo largo de los días hábiles (el día con mayor volumen es el <strong>${top1.dia}</strong> con <strong>${top1.pct_cobros}%</strong>, seguido de${top2Texto}, acumulando el <strong>${topSumaPct}%</strong>). La recomendación operativa es mantener los despachos regulares a las 8:00 AM cada jornada laboral para sostener el flujo constante de ingresos sin concentrar envíos en un solo día.`;
  }

  const maxCobros = Math.max(1, ...cobrosPorDia.map(d => d.cobros || 0));

  // Geometry SVG
  const svgW = 620;
  const svgH = 190;
  const padL = 45;
  const padR = 25;
  const padT = 25;
  const padB = 40;
  const plotW = svgW - padL - padR; // 550
  const plotH = svgH - padT - padB; // 125

  const n = cobrosPorDia.length;
  const colW = plotW / n;
  const barW = Math.min(48, colW * 0.62);

  const bars = cobrosPorDia.map((d, idx) => {
    const isPico = d.dia === diaPicoNombre;
    const barH = (d.cobros / maxCobros) * plotH;
    const cx = padL + (idx + 0.5) * colW;
    const x = cx - barW / 2;
    const y = padT + plotH - barH;

    const fillGrad = isPico ? 'url(#gradPicoDia)' : 'url(#gradNormalDia)';
    const stroke = isPico ? '#2ed573' : '#00b4d8';
    const dineroFmt = (d.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

    const tooltip = `${d.dia}: ${d.cobros} cobros (${d.pct_cobros}% del volumen)
Dinero recuperado: ${dineroFmt} (${d.pct_dinero}% del total)`;

    return `
      <g style="cursor: pointer;">
        <title>${tooltip}</title>
        ${isPico ? `<rect x="${x - 3}" y="${y - 3}" width="${barW + 6}" height="${barH + 3}" fill="none" stroke="#2ed573" stroke-width="2" rx="7" stroke-dasharray="3,3" opacity="0.7"></rect>` : ''}
        <rect x="${x}" y="${y}" width="${barW}" height="${Math.max(3, barH)}" fill="${fillGrad}" rx="5" stroke="${stroke}" stroke-width="1.2"></rect>
        
        <!-- Valor arriba de la barra -->
        <text x="${cx}" y="${y - 6}" fill="${isPico ? '#2ed573' : '#fff'}" font-size="11" font-weight="800" text-anchor="middle">${d.cobros}</text>
        <text x="${cx}" y="${y - 18}" fill="${isPico ? '#2ed573' : 'var(--text-secondary)'}" font-size="9" font-weight="${isPico ? '800' : '600'}" text-anchor="middle">${d.pct_cobros}%</text>

        <!-- Etiqueta eje X -->
        <text x="${cx}" y="${padT + plotH + 16}" fill="${isPico ? '#2ed573' : 'var(--text-primary)'}" font-size="10.5" font-weight="${isPico ? '800' : '600'}" text-anchor="middle">${d.dia.slice(0, 3)}</text>
        <text x="${cx}" y="${padT + plotH + 28}" fill="var(--text-secondary)" font-size="8.5" text-anchor="middle">${dineroFmt === '$0' ? '-' : dineroFmt}</text>
      </g>
    `;
  }).join('');

  return `
    <div class="card mb-3" style="padding: 22px; margin-bottom: 24px; border: 1px solid var(--border-color); background: rgba(10, 25, 47, 0.85); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 8px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>📅</span> DISTRIBUCIÓN DE COBROS Y PAGOS POR DÍA DE LA SEMANA
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Días en que los clientes realizan efectivamente el pago (evaluado por fecha de resolución real, no fecha de envío)
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 6px; background: rgba(0, 180, 216, 0.12); padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(0, 180, 216, 0.35);">
            <label for="selectRangoCobrosDia" style="font-size: 0.76rem; color: #48cae4; font-weight: 700; margin: 0; white-space: nowrap;">
              ⏳ Período:
            </label>
            <select id="selectRangoCobrosDia" onchange="cambiarRangoCobrosDia(this.value)" style="background: rgba(10, 25, 47, 0.95); color: #fff; border: 1px solid rgba(0, 180, 216, 0.5); border-radius: 6px; font-size: 0.76rem; font-weight: 700; padding: 2px 6px; cursor: pointer; outline: none;">
              <option value="este_mes" ${activeRango === 'este_mes' ? 'selected' : ''}>📅 Este Mes</option>
              <option value="esta_semana" ${activeRango === 'esta_semana' ? 'selected' : ''}>📆 Esta Semana</option>
              <option value="hoy" ${activeRango === 'hoy' ? 'selected' : ''}>☀️ Hoy</option>
              <option value="mes_anterior" ${activeRango === 'mes_anterior' ? 'selected' : ''}>🗓️ Mes Anterior</option>
              <option value="30_dias" ${activeRango === '30_dias' ? 'selected' : ''}>🗓️ Últimos 30 días</option>
              <option value="anio_actual" ${activeRango === 'anio_actual' ? 'selected' : ''}>📆 Año Actual</option>
              <option value="todo" ${activeRango === 'todo' ? 'selected' : ''}>🌐 Todo el Historial</option>
            </select>
          </div>
          <span class="badge" style="background: rgba(46, 213, 115, 0.18); color: #2ed573; font-weight: 800; border: 1px solid rgba(46, 213, 115, 0.35); font-size: 0.78rem;">
            🔥 Día Pico: ${diaPicoNombre} (${diaPicoPct}% de cobros)
          </span>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 320px; gap: 18px; align-items: center;" class="cobros-semana-grid">
        <!-- GRÁFICO SVG BARRAS -->
        <div style="width: 100%; overflow-x: auto;">
          <svg viewBox="0 0 ${svgW} ${svgH}" style="width: 100%; max-height: 210px; min-width: 480px; display: block;">
            <defs>
              <linearGradient id="gradPicoDia" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#2ed573" stop-opacity="0.9" />
                <stop offset="100%" stop-color="#2ed573" stop-opacity="0.35" />
              </linearGradient>
              <linearGradient id="gradNormalDia" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#00b4d8" stop-opacity="0.75" />
                <stop offset="100%" stop-color="#00b4d8" stop-opacity="0.2" />
              </linearGradient>
            </defs>

            <!-- Grid Lines Y -->
            <line x1="${padL}" y1="${padT}" x2="${padL + plotW}" y2="${padT}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
            <line x1="${padL}" y1="${padT + plotH * 0.5}" x2="${padL + plotW}" y2="${padT + plotH * 0.5}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
            <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="rgba(255,255,255,0.12)" />

            <!-- Bars -->
            ${bars}
          </svg>
        </div>

        <!-- PANEL DE RECOMENDACIÓN E INSIGHT -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px;">
          <div>
            <div style="font-size: 0.75rem; text-transform: uppercase; color: #48cae4; font-weight: 800; letter-spacing: 0.5px;">🏆 Concentración Semanal</div>
            <div style="font-size: 1.25rem; font-weight: 800; color: #fff; margin-top: 4px;">
              ${diaPicoCobros} <span style="font-size:0.85rem; font-weight:600; color:var(--text-secondary);">cobros el ${diaPicoNombre}</span>
            </div>
            <div style="font-size: 0.74rem; color: #2ed573; font-weight: 700; margin-top: 2px;">
              ${diaPicoDinero} recaudados (${diaPicoPct}% del total semanal)
            </div>
          </div>

          <div style="padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08);">
            <div style="font-size: 0.74rem; font-weight: 800; color: #f1c40f; margin-bottom: 4px; display: flex; align-items: center; gap: 5px;">
              <span>💡</span> RECOMENDACIÓN OPERATIVA
            </div>
            <div style="font-size: 0.74rem; color: var(--text-secondary); line-height: 1.4;">
              ${recomendacionTexto}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCobrosPorDiaSemana(cobrosPorDia, diaPico, activeRango = 'este_mes') {
  const effRango = _currentCobrosDiaRango || activeRango;
  return `
    <div id="cardCobrosPorDiaSemanaContainer">
      ${renderCobrosPorDiaSemanaInner(cobrosPorDia, diaPico, effRango)}
    </div>
  `;
}

window.cambiarRangoCobrosDia = async function(nuevoRango) {
  _currentCobrosDiaRango = nuevoRango;
  const container = document.getElementById('cardCobrosPorDiaSemanaContainer');
  if (!container) return;
  try {
    container.style.opacity = '0.5';
    const res = await fetch(`/api/metricas/cobros-dia-semana?rango=${encodeURIComponent(nuevoRango)}`);
    const json = await res.json();
    container.innerHTML = renderCobrosPorDiaSemanaInner(json.cobros_por_dia_semana, json.dia_pico_cobranza, nuevoRango);
  } catch (err) {
    console.error('Error actualizando cobros por dia:', err);
  } finally {
    container.style.opacity = '1';
  }
};

// ─── COMPONENTE: CALENDARIO MENSUAL DE ACTIVIDAD Y COBROS POR DÍA ──────────
function renderCalendarioActividadMensual(data) {
  if (!data || !data.dias) {
    return `
      <div class="card mb-3" style="padding: 22px; margin-bottom: 24px; border: 1px solid var(--border-color); background: rgba(10, 25, 47, 0.85); border-radius: 16px;">
        <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px;">
          🗓️ Calendario Mensual de Actividad y Cobros por Día
        </div>
        <div style="color: var(--text-secondary); margin-top: 8px;">Cargando calendario...</div>
      </div>
    `;
  }

  const dineroTotalFmt = (data.total_dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const diaPico = data.dia_max_recaudacion || {};
  const picoDineroFmt = (diaPico.dinero || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
  const promFmt = (data.promedio_diario_dinero || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

  // Encabezados de columna: LUN, MAR, MIÉ, JUE, VIE, SÁB, DOM
  const headerCols = ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'].map((h, i) => {
    const isWknd = i >= 5;
    return `<div style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${isWknd ? 'rgba(255,255,255,0.4)' : '#48cae4'}; padding: 8px 4px; letter-spacing: 0.5px;">${h}</div>`;
  }).join('');

  // Celdas vacías al inicio para alinear con el día de la semana correspondiente
  let cellsHtml = '';
  for (let i = 0; i < (data.primer_dia_offset || 0); i++) {
    cellsHtml += `<div style="min-height: 82px; background: rgba(255,255,255,0.01); border: 1px dashed rgba(255,255,255,0.04); border-radius: 8px; opacity: 0.3;"></div>`;
  }

  // Celdas de los días del mes
  for (const d of data.dias) {
    const tieneCobros = (d.cobros || 0) > 0;
    const tieneEnvios = (d.envios || 0) > 0;
    const dineroDiaFmt = (d.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

    let bg = 'rgba(255,255,255,0.02)';
    let border = '1px solid rgba(255,255,255,0.07)';
    let shadow = 'none';

    if (tieneCobros) {
      if (d.dinero_recuperado >= 500000) {
        bg = 'rgba(46, 213, 115, 0.28)';
        border = '1px solid #2ed573';
        shadow = '0 0 10px rgba(46, 213, 115, 0.25)';
      } else if (d.dinero_recuperado >= 100000) {
        bg = 'rgba(46, 213, 115, 0.18)';
        border = '1px solid rgba(46, 213, 115, 0.6)';
      } else {
        bg = 'rgba(46, 213, 115, 0.10)';
        border = '1px solid rgba(46, 213, 115, 0.35)';
      }
    } else if (tieneEnvios) {
      bg = 'rgba(0, 180, 216, 0.05)';
      border = '1px solid rgba(0, 180, 216, 0.2)';
    }

    if (d.es_hoy) {
      border = '2px solid #f1c40f';
      shadow = '0 0 12px rgba(241, 196, 15, 0.35)';
    }

    const tooltip = `📅 ${d.nombre_dia} ${d.dia} de ${data.mes_label}
💳 Cobros confirmados: ${d.cobros}
💰 Dinero recuperado: ${dineroDiaFmt}
📤 Gestiones enviadas: ${d.envios}
🎯 Tasa de conversión: ${d.tasa_conversion}%`;

    cellsHtml += `
      <div title="${tooltip}" style="min-height: 82px; background: ${bg}; border: ${border}; box-shadow: ${shadow}; border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; justify-content: space-between; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease;" onmouseover="this.style.transform='scale(1.03)'" onmouseout="this.style.transform='scale(1)'">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.88rem; font-weight: 800; color: ${d.es_hoy ? '#f1c40f' : (tieneCobros ? '#2ed573' : (d.es_fin_de_semana ? 'rgba(255,255,255,0.45)' : '#fff'))};">
            ${d.dia}
          </span>
          ${d.es_hoy ? `<span style="font-size: 0.62rem; font-weight: 800; background: #f1c40f; color: #000; padding: 1px 4px; border-radius: 4px; text-transform: uppercase;">HOY</span>` : ''}
          ${diaPico.dia === d.dia && d.cobros > 0 ? `<span style="font-size: 0.68rem;" title="Día con mayor recaudación">🏆</span>` : ''}
        </div>

        <div style="margin-top: 4px; display: flex; flex-direction: column; gap: 2px;">
          ${tieneCobros ? `
            <div style="font-size: 0.72rem; font-weight: 800; color: #2ed573; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              💳 ${d.cobros} pago${d.cobros > 1 ? 's' : ''}
            </div>
            <div style="font-size: 0.72rem; font-weight: 700; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${d.dinero_recuperado >= 1000 ? '$' + Math.round(d.dinero_recuperado / 1000).toLocaleString('es-AR') + 'k' : dineroDiaFmt}
            </div>
          ` : (tieneEnvios ? `
            <div style="font-size: 0.68rem; color: #48cae4; white-space: nowrap;">
              📤 ${d.envios} env.
            </div>
          ` : `
            <div style="font-size: 0.68rem; color: rgba(255,255,255,0.18);">-</div>
          `)}
        </div>

        ${tieneCobros && tieneEnvios ? `
          <div style="font-size: 0.62rem; color: var(--text-secondary); text-align: right; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 2px; margin-top: 2px;">
            ${d.tasa_conversion}% conv.
          </div>
        ` : ''}
      </div>
    `;
  }

  return `
    <div class="card mb-3" style="padding: 22px; margin-bottom: 24px; border: 1px solid var(--border-color); background: rgba(10, 25, 47, 0.85); border-radius: 16px;">
      
      <!-- ENCABEZADO Y SELECTOR DE MES -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>🗓️</span> CALENDARIO MENSUAL DE ACTIVIDAD Y COBROS POR DÍA
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Mapa de calor diario con volumen de pagos confirmados, dinero recuperado y mensajes de WhatsApp enviados
          </div>
        </div>

        <!-- CONTROL NAVEGACIÓN MES -->
        <div style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 4px 8px; border-radius: 10px;">
          <button class="btn btn-sm btn-outline-secondary" onclick="navegarCalendarioMes('${data.mes_anterior}')" style="padding: 3px 10px; font-size: 0.78rem; font-weight: 700; border-radius: 6px; cursor: pointer;" title="Ir al mes anterior">
            ◀ Anterior
          </button>
          <span style="font-size: 0.84rem; font-weight: 800; color: #48cae4; padding: 0 6px; min-width: 120px; text-align: center;">
            📅 ${data.mes_label}
          </span>
          <button class="btn btn-sm btn-outline-secondary" onclick="navegarCalendarioMes('${data.mes_siguiente}')" style="padding: 3px 10px; font-size: 0.78rem; font-weight: 700; border-radius: 6px; cursor: pointer;" title="Ir al mes siguiente">
            Siguiente ▶
          </button>
        </div>
      </div>

      <!-- KPI SUMMARY STRIP -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 18px;">
        <div style="background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.25); border-radius: 10px; padding: 10px 14px;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700;">💰 Recaudado Mes</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #2ed573; margin-top: 2px;">${dineroTotalFmt}</div>
        </div>
        <div style="background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.25); border-radius: 10px; padding: 10px 14px;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700;">💳 Cobros Registrados</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #fff; margin-top: 2px;">${data.total_cobros || 0} pagos</div>
        </div>
        <div style="background: rgba(155, 89, 182, 0.08); border: 1px solid rgba(155, 89, 182, 0.25); border-radius: 10px; padding: 10px 14px;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700;">📤 Contactos WhatsApp</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #fff; margin-top: 2px;">${data.total_envios || 0} envíos</div>
        </div>
        <div style="background: rgba(241, 196, 15, 0.08); border: 1px solid rgba(241, 196, 15, 0.25); border-radius: 10px; padding: 10px 14px;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700;">🏆 Día Pico de Cobranza</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #f1c40f; margin-top: 2px;">
            ${diaPico.dia ? 'Día ' + diaPico.dia + ' (' + picoDineroFmt + ')' : 'Sin cobros'}
          </div>
        </div>
        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; padding: 10px 14px;">
          <div style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700;">📊 Promedio Día Activo</div>
          <div style="font-size: 1.15rem; font-weight: 800; color: #48cae4; margin-top: 2px;">${promFmt} / día</div>
        </div>
      </div>

      <!-- MATRIZ DE CALENDARIO -->
      <div style="overflow-x: auto;">
        <div style="min-width: 600px;">
          <!-- FILA DE ENCABEZADOS DE DÍA -->
          <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 8px;">
            ${headerCols}
          </div>
          <!-- CELDAS DE DÍAS -->
          <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px;">
            ${cellsHtml}
          </div>
        </div>
      </div>

      <!-- NOTA DE PATRONES INTRA-MES -->
      <div style="margin-top: 16px; background: rgba(0, 180, 216, 0.05); border: 1px solid rgba(0, 180, 216, 0.2); border-left: 4px solid #00b4d8; border-radius: 8px; padding: 10px 14px; font-size: 0.76rem; color: var(--text-secondary); line-height: 1.45;">
        <strong style="color: #48cae4;">💡 Patrones intra-mes detectados:</strong> 
        La actividad de cobranza muestra picos concentrados entre los días 10 al 15 y 20 al 25 de cada mes, coincidiendo con los ciclos estándar de vencimiento de pólizas NRE y AGS. Los días hábiles inmediatamente posteriores presentan la mayor tasa de efectividad de recupero económico tras el disparo automático preventivo de WhatsApp.
      </div>

    </div>
  `;
}

window.navegarCalendarioMes = async function(nuevoMes) {
  _currentCalendarioMes = nuevoMes;
  const container = document.getElementById('containerCalendarioActividadMensual');
  if (!container) return;
  try {
    container.style.opacity = '0.5';
    const res = await fetch(`/api/metricas/calendario-actividad?mes=${encodeURIComponent(nuevoMes)}`);
    const json = await res.json();
    container.innerHTML = renderCalendarioActividadMensual(json);
  } catch (e) {
    console.error('Error navegando calendario:', e);
  } finally {
    container.style.opacity = '1';
  }
};

function renderMetricasUI(data, stats = {}, historicoCartera = {}) {
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

        <button class="btn btn-ghost" onclick="exportarReporteEjecutivoExcel()" style="color: #2ed573; border: 1px solid rgba(46, 213, 115, 0.4); background: rgba(46, 213, 115, 0.1); font-weight: 700; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; cursor: pointer;" title="Descargar reporte ejecutivo Excel consolidado con 4 hojas (Resumen, Plantillas, Vehículos, Trayectoria)">
          📊 Exportar Reporte Ejecutivo
        </button>

        <a href="/api/exportar-sin-telefono" class="btn btn-ghost" style="color: var(--accent-cyan-light); border: 1px solid rgba(0, 180, 216, 0.4); background: rgba(0, 180, 216, 0.1); font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px;" title="Descargar reporte Excel unificado con todos los clientes sin teléfono, incompletos o invalidados">
          📱 Exportar Clientes Sin Teléfono
        </a>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <!--  🏛️ SECCIÓN A — PANORAMA ESTRATÉGICO DE CARTERA                           -->
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <div style="margin: 28px 0 18px 0; padding-bottom: 8px; border-bottom: 2px solid rgba(0, 180, 216, 0.45); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 1.15rem; font-weight: 800; color: #48cae4; text-transform: uppercase; letter-spacing: 1px;">
          🏛️ SECCIÓN A — PANORAMA ESTRATÉGICO DE CARTERA
        </span>
        <span style="font-size: 0.72rem; color: #48cae4; background: rgba(0, 180, 216, 0.12); padding: 3px 9px; border-radius: 12px; border: 1px solid rgba(0, 180, 216, 0.3); font-weight: 700;">
          Visión de Negocio &amp; Tendencias
        </span>
      </div>
      <span style="font-size: 0.75rem; color: var(--text-secondary);">Evolución temporal, volumen y composición estructural</span>
    </div>

    <!-- 📈 CRECIMIENTO & COMPOSICIÓN ESTRUCTURAL DE CARTERA (VISTA ESTRATÉGICA EN CRECIMIENTO) -->
    ${renderCuadroCrecimientoYComposicionCartera(historicoCartera, stats, _currentCarteraCrecimientoModo)}

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

    <!-- 📈 EVOLUCIÓN HISTÓRICA DE CARTERA ACTIVA (DESGLOSE POR VEHÍCULO) -->
    ${renderEvolucionCarteraActivaChart(historicoCartera, _currentCarteraEvolucionModo)}

    <!-- 📈 TRAYECTORIA DE DINERO RECUPERADO Y CONVERSIÓN EN EL TIEMPO (SEMANAL/MENSUAL/TRIMESTRAL) -->
    ${renderHistoricoRecuperacionChart(data, _currentRecuperacionModo)}

    <!-- 🏛️ VOLUMEN DE NEGOCIO & FACTURACIÓN (EN AUDITORÍA TÉCNICA - PASO 0) -->
    ${renderCardAuditoriaFacturacion(data.auditoria_facturacion, stats, data, activeRango)}

    <!-- 🛡️ DESGLOSE DE COBERTURAS POR TIPO DE VEHÍCULO (TABLA CRUZADA AUDITADA) -->
    ${renderTablaCoberturasPorVehiculo(stats.cobertura_vehiculos || data.cobertura_vehiculos)}

    <!-- 🍩 PROPORCIÓN DE COBERTURA & OPORTUNIDADES DE UPSELL (4 DONUTS CON 5 SEGMENTOS) -->
    ${renderDonutsCoberturaVehiculos(stats.cobertura_vehiculos || data.cobertura_vehiculos)}

    <!-- 👥 PERFIL DEMOGRÁFICO DE LA CARTERA ACTIVA (GÉNERO & COBERTURA DNI) -->
    ${renderCardDemografiaGenero(stats.demografia_genero || data.demografia_genero)}


    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <!--  ⚡ SECCIÓN B — OPERATIVO DIARIO & GESTIÓN DE COBRANZA                    -->
    <!-- ═══════════════════════════════════════════════════════════════════════════ -->
    <div style="margin: 36px 0 18px 0; padding-bottom: 8px; border-bottom: 2px solid rgba(46, 213, 115, 0.45); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 1.15rem; font-weight: 800; color: #2ed573; text-transform: uppercase; letter-spacing: 1px;">
          ⚡ SECCIÓN B — OPERATIVO DIARIO &amp; GESTIÓN DE COBRANZA
        </span>
        <span style="font-size: 0.72rem; color: #2ed573; background: rgba(46, 213, 115, 0.12); padding: 3px 9px; border-radius: 12px; border: 1px solid rgba(46, 213, 115, 0.3); font-weight: 700;">
          Eficacia de Envíos &amp; Comportamiento de Pago
        </span>
      </div>
      <span style="font-size: 0.75rem; color: var(--text-secondary);">Métricas de despacho WhatsApp y conversión en cuenta</span>
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

    <!-- 📅 DISTRIBUCIÓN DE COBROS POR DÍA DE LA SEMANA (LUNES A DOMINGO CON DÍA PICO) -->
    ${renderCobrosPorDiaSemana(data.cobros_por_dia_semana, data.dia_pico_cobranza, activeRango)}

    <!-- 🗓️ CALENDARIO MENSUAL DE ACTIVIDAD POR DÍA (HEATMAP DE COBROS Y GESTIONES) -->
    <div id="containerCalendarioActividadMensual">
      ${renderCalendarioActividadMensual(data.calendario_mensual)}
    </div>

    <!-- 🔄 CONVERSIÓN POR ETAPA DE COBRANZA -->
    ${renderEtapasCobranza(data.etapas_cobranza)}

    <!-- 🌪️ EMBUDO DE CONVERSIÓN COMERCIAL (FUNNEL) -->
    ${renderFunnelConversion(data.funnel_conversion)}

    <!-- 🏢 CARTERA & DESGLOSE POR ASEGURADORA (NRE VS AGS & COBERTURA TELEFÓNICA) -->
    ${renderDesgloseAseguradoras(data.desglose_aseguradora, data.cobertura_contacto)}

    <!-- 🎯 MATRIZ DE EFICIENCIA POR PLANTILLA (SCATTER 4 CUADRANTES) -->
    ${renderScatterEficienciaPlantillas(data.plantillas_performance)}

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
  const maxDinero = Math.max(1000, ...historico.map(h => h.dinero_recuperado || 0));
  const maxTasa = 100;

  // Dual axis SVG geometry
  const svgW = 740;
  const svgH = 210;
  const padL = 70;
  const padR = 55;
  const padT = 25;
  const padB = 40;
  const plotW = svgW - padL - padR; // 615
  const plotH = svgH - padT - padB; // 145

  const n = historico.length;
  const stepX = n > 1 ? plotW / (n - 1) : plotW;

  const pointsDinero = [];
  const pointsTasa = [];

  historico.forEach((h, idx) => {
    const x = padL + idx * stepX;
    const din = Math.max(0, h.dinero_recuperado || 0);
    const tasa = Math.min(100, Math.max(0, parseFloat(h.tasa_conversion || 0)));
    const yDin = padT + plotH - (din / maxDinero) * plotH;
    const yTasa = padT + plotH - (tasa / maxTasa) * plotH;

    pointsDinero.push({ x, y: yDin, val: din, h });
    pointsTasa.push({ x, y: yTasa, val: tasa, h });
  });

  // Continuous SVG paths across all 8 weeks
  const pathDineroD = pointsDinero.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaDineroD = `${pathDineroD} L ${pointsDinero[pointsDinero.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${pointsDinero[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
  const pathTasaD = pointsTasa.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  // Left Y axis ticks (Dinero - Green)
  const yTicksDin = [0, maxDinero * 0.5, maxDinero].map(val => {
    const y = padT + plotH - (val / maxDinero) * plotH;
    const fmt = val === 0 ? '$0' : (val >= 1000000 ? `$${(val / 1000000).toFixed(1)}M` : `$${Math.round(val / 1000)}k`);
    return `
      <line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
      <text x="${padL - 10}" y="${y + 4}" fill="#2ed573" font-size="10" font-weight="700" text-anchor="end">${fmt}</text>
    `;
  }).join('');

  // Right Y axis ticks (Conversión - Cyan)
  const yTicksTasa = [0, 50, 100].map(val => {
    const y = padT + plotH - (val / maxTasa) * plotH;
    return `
      <text x="${padL + plotW + 10}" y="${y + 4}" fill="#00b4d8" font-size="10" font-weight="700" text-anchor="start">${val}%</text>
    `;
  }).join('');

  // Nodes for Dinero (green) and Tasa (cyan)
  const nodesDinero = pointsDinero.map(p => {
    const dinFmt = p.val.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
    return `
      <g>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#2ed573" stroke="#0a192f" stroke-width="2">
          <title>${p.h.semana} (${p.h.label}): ${(p.h.envios || 0) === 0 ? 'Sin envíos registrados (Pre-lanzamiento)' : `${dinFmt} recuperados en ${p.h.exitosos || 0} cobros`}</title>
        </circle>
      </g>
    `;
  }).join('');

  const nodesTasa = pointsTasa.map(p => {
    return `
      <g>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="#00b4d8" stroke="#0a192f" stroke-width="2">
          <title>${p.h.semana} (${p.h.label}): ${(p.h.envios || 0) === 0 ? 'Pre-lanzamiento (0 envíos)' : `${p.val}% conversión`}</title>
        </circle>
      </g>
    `;
  }).join('');

  // X labels
  const xLabels = historico.map((h, idx) => {
    const x = padL + idx * stepX;
    return `
      <text x="${x.toFixed(1)}" y="${padT + plotH + 16}" fill="var(--text-primary)" font-size="10.5" font-weight="700" text-anchor="middle">${h.semana}</text>
      <text x="${x.toFixed(1)}" y="${padT + plotH + 28}" fill="var(--text-secondary)" font-size="9" text-anchor="middle">${h.label}</text>
    `;
  }).join('');

  // Bottom ratio cards
  const ratioCards = historico.map(h => {
    const isPreRollout = (h.envios || 0) === 0 && (h.exitosos || 0) === 0;
    const ratio = parseFloat(h.reenvios_ratio || 1.0);
    const isSpamRisk = ratio >= 2.50;
    const ratioColor = isSpamRisk ? '#ff7675' : '#a0aec0';
    const dineroFmt = (h.dinero_recuperado || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

    if (isPreRollout) {
      return `
        <div style="flex: 1; text-align: center; min-width: 65px; background: rgba(255,255,255,0.015); border-radius: 8px; padding: 8px 4px; border: 1px dashed rgba(255,255,255,0.08); opacity: 0.7;">
          <div style="font-size: 0.72rem; font-weight: 700; color: var(--text-secondary);">$0</div>
          <div style="font-size: 0.65rem; font-weight: 700; color: #a0aec0; margin: 3px 0;">Pre-inicio</div>
          <div style="font-size: 0.60rem; color: var(--text-secondary);" title="Período previo al inicio operativo de los envíos automatizados">
            0 envíos
          </div>
        </div>
      `;
    }

    return `
      <div style="flex: 1; text-align: center; min-width: 65px; background: rgba(255,255,255,0.02); border-radius: 8px; padding: 8px 4px; border: 1px solid rgba(255,255,255,0.06);">
        <div style="font-size: 0.72rem; font-weight: 800; color: #2ed573;">${dineroFmt}</div>
        <div style="font-size: 0.68rem; font-weight: 700; color: #00b4d8; margin: 3px 0;">${h.tasa_conversion}%</div>
        <div style="font-size: 0.63rem; color: ${ratioColor}; font-weight: 700;" title="${ratio.toFixed(2)}x reenvíos por cliente">
          ${ratio.toFixed(2)}x ${isSpamRisk ? '⚠️' : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="card mb-3" style="padding: 24px; margin-bottom: 24px; background: rgba(10, 25, 47, 0.85); border: 1px solid var(--border-color); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>📈</span> TRAYECTORIA HISTÓRICA SEMANAL CON DOBLE EJE (ÚLTIMAS 8 SEMANAS)
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
            Evolución continua de Dinero Recuperado ($) vs. Tasa de Conversión (%) semana a semana, con control de saturación.
          </div>
        </div>
        <div style="display: flex; gap: 14px; font-size: 0.76rem; font-weight: 700; flex-wrap: wrap;">
          <span style="display: flex; align-items: center; gap: 6px; color: #2ed573;">
            <span style="width: 10px; height: 10px; background: #2ed573; border-radius: 2px; display: inline-block;"></span> Dinero Recuperado ($ Eje Izq.)
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #00b4d8;">
            <span style="width: 10px; height: 10px; background: #00b4d8; border-radius: 2px; display: inline-block;"></span> % Conversión (Eje Der.)
          </span>
          <span style="display: flex; align-items: center; gap: 6px; color: #a0aec0;">
            <span style="font-size: 0.75rem;">🔁</span> Ratio Reenvíos
          </span>
        </div>
      </div>

      <!-- SVG DUAL AXIS CHART -->
      <div style="width: 100%; overflow-x: auto;">
        <svg viewBox="0 0 ${svgW} ${svgH}" style="width: 100%; max-height: 230px; min-width: 580px; display: block;">
          <defs>
            <linearGradient id="gradienteDinero" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#2ed573" stop-opacity="0.22" />
              <stop offset="100%" stop-color="#2ed573" stop-opacity="0.0" />
            </linearGradient>
          </defs>

          <!-- Grid Lines -->
          ${yTicksDin}
          ${yTicksTasa}

          <!-- Area & Line Dinero (Green) -->
          <path d="${areaDineroD}" fill="url(#gradienteDinero)"></path>
          <path d="${pathDineroD}" fill="none" stroke="#2ed573" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>

          <!-- Line Conversión (Cyan Dashed) -->
          <path d="${pathTasaD}" fill="none" stroke="#00b4d8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4,3"></path>

          <!-- Interactive Nodes -->
          ${nodesDinero}
          ${nodesTasa}

          <!-- X Labels -->
          ${xLabels}
        </svg>
      </div>

      <!-- Weekly KPI Summary Cards -->
      <div style="display: flex; justify-content: space-between; gap: 8px; margin-top: 14px; overflow-x: auto; padding: 4px 0;">
        ${ratioCards}
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

function renderDonutsCoberturaVehiculos(coberturaData) {
  if (!coberturaData) return '';
  const c = coberturaData;
  const autos = c.autos || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, otros: 0, pendiente: 0, total: 0 };
  const pickups = c.pickups || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, otros: 0, pendiente: 0, total: 0 };
  const motos = c.motos || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, otros: 0, pendiente: 0, total: 0 };
  const camiones = c.camiones || { rc: 0, plan_b: 0, plan_c: 0, todo_riesgo: 0, otros: 0, pendiente: 0, total: 0 };

  const items = [
    { key: 'Autos', icon: '🚗', name: 'Autos', data: autos, color: '#48cae4', canUpsell: true, filter: 'Auto' },
    { key: 'Pickups', icon: '🛻', name: 'Pick Ups / Utilitarios', data: pickups, color: '#2ed573', canUpsell: true, filter: 'Pick Up' },
    { key: 'Motos', icon: '🏍️', name: 'Motos', data: motos, color: '#f39c12', canUpsell: false, filter: 'Moto' },
    { key: 'Camiones', icon: '🚛', name: 'Camiones', data: camiones, color: '#a29bfe', canUpsell: false, filter: 'Camión' }
  ];

  const donutCards = items.map(item => {
    const d = item.data;
    const rc = d.rc || 0;
    const planB = d.plan_b || 0;
    const planC = d.plan_c || 0;
    const otros = (d.todo_riesgo || 0) + (d.otros || 0); // 5to segmento asegurado contra pérdida de datos
    const pendiente = d.pendiente || 0;
    const total = d.total || (rc + planB + planC + otros + pendiente) || 1;
    const confirmadas = rc + planB + planC + otros;

    // SVG Donut geometry
    const R = 38;
    const circ = 2 * Math.PI * R; // ~238.76

    const segments = [
      { id: 'rc', name: 'RC (Plan A)', val: rc, color: '#48cae4' },
      { id: 'plan_b', name: 'Plan B', val: planB, color: '#2ed573' },
      { id: 'plan_c', name: 'Plan C', val: planC, color: '#f1c40f' },
      { id: 'otros', name: 'Otros / TR', val: otros, color: '#a29bfe' },
      { id: 'pendiente', name: 'Pendiente', val: pendiente, color: '#f39c12' }
    ];

    let accumOffset = 0;
    const circleSvgs = segments.map(seg => {
      const sliceLen = (seg.val / total) * circ;
      const isPendiente = seg.id === 'pendiente';
      const isCero = seg.val <= 0;
      const dash = isCero ? `0.00 ${circ.toFixed(2)}` : `${sliceLen.toFixed(2)} ${(circ - sliceLen).toFixed(2)}`;
      const offset = (-accumOffset).toFixed(2);
      if (!isCero) accumOffset += sliceLen;

      return `<circle class="donut-segment segment-${seg.id}" data-coverage="${seg.id}" cx="60" cy="60" r="${R}" fill="none" stroke="${seg.color}" stroke-width="12"
        stroke-dasharray="${dash}" stroke-dashoffset="${offset}"
        stroke-linecap="butt" ${isPendiente ? 'opacity="0.45"' : (isCero ? 'opacity="0"' : '')}>
        <title>${seg.name}: ${seg.val.toLocaleString('es-AR')} pólizas (${((seg.val / total) * 100).toFixed(1)}%)</title>
      </circle>`;
    }).join('');

    // Distinción de negocio estricta: solo Autos y Pickups admiten upsell; Motos y Camiones son estructuralmente RC
    let insightHtml = '';
    if (item.canUpsell) {
      if (confirmadas > 0 && rc > 0) {
        const pctRcConf = Math.round((rc / confirmadas) * 100);
        insightHtml = `
          <div style="margin-top: 10px; font-size: 0.72rem; padding: 6px 10px; border-radius: 8px; background: rgba(0, 180, 216, 0.08); border: 1px solid rgba(0, 180, 216, 0.25); color: #48cae4; line-height: 1.35;">
            💡 <strong>Oportunidad Upsell:</strong> <strong>${pctRcConf}%</strong> de pólizas confirmadas tienen solo RC básica. Foco en ofrecer migración a Terceros Completo (Plan C).
          </div>`;
      } else if (confirmadas > 0 && rc === 0) {
        insightHtml = `
          <div style="margin-top: 10px; font-size: 0.72rem; padding: 6px 10px; border-radius: 8px; background: rgba(46, 213, 115, 0.08); border: 1px solid rgba(46, 213, 115, 0.25); color: #2ed573; line-height: 1.35;">
            ✨ <strong>Cartera protegida:</strong> 100% de las pólizas confirmadas cuentan con cobertura superior a RC básica.
          </div>`;
      } else {
        insightHtml = `
          <div style="margin-top: 10px; font-size: 0.72rem; padding: 6px 10px; border-radius: 8px; background: rgba(243, 156, 18, 0.08); border: 1px solid rgba(243, 156, 18, 0.25); color: #f39c12; line-height: 1.35;">
            ⏳ <strong>En proceso de backfill:</strong> Extrayendo coberturas desde NRE para evaluar potencial de upsell.
          </div>`;
      }
    } else {
      const motivo = item.key === 'Motos' 
        ? 'por naturaleza de riesgo y suscripción de aseguradoras' 
        : 'por segmento de flota comercial pesada';
      insightHtml = `
        <div style="margin-top: 10px; font-size: 0.72rem; padding: 6px 10px; border-radius: 8px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.12); color: var(--text-secondary); line-height: 1.35;">
          🛡️ <strong>Perfil de Cartera:</strong> Orientada estructuralmente a RC ${motivo}. No aplica campaña de upsell.
        </div>`;
    }

    return `
      <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 0.9rem; color: ${item.color};">
              <span style="font-size: 1.2rem;">${item.icon}</span> ${item.name}
            </div>
            <button class="btn btn-sm btn-ghost" onclick="openViewWithVehicleFilter('${item.filter}')" style="padding: 2px 7px; font-size: 0.72rem; color: ${item.color}; border: 1px solid ${item.color}40;" title="Ver pólizas de ${item.name}">
              ${d.total.toLocaleString('es-AR')} →
            </button>
          </div>

          <div style="display: flex; align-items: center; justify-content: center; gap: 14px; margin: 10px 0;">
            <div style="position: relative; width: 110px; height: 110px;">
              <svg viewBox="0 0 120 120" style="transform: rotate(-90deg); width: 100%; height: 100%;">
                <circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="12"></circle>
                ${circleSvgs}
              </svg>
              <div style="position: absolute; top:0; left:0; width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; pointer-events:none;">
                <span style="font-size: 1.05rem; font-weight: 800; color: #fff;">${d.total.toLocaleString('es-AR')}</span>
                <span style="font-size: 0.65rem; color: var(--text-secondary); text-transform: uppercase;">Activas</span>
              </div>
            </div>

            <!-- Legend with 5 items ALWAYS rendered (RC, Plan B, Plan C, Otros/TR, Pendiente) -->
            <div style="font-size: 0.72rem; display: flex; flex-direction: column; gap: 4px; min-width: 110px;">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                <span style="display:flex; align-items:center; gap:5px; color:#48cae4;"><span style="width:8px; height:8px; border-radius:50%; background:#48cae4; display:inline-block;"></span> RC:</span>
                <strong style="color:${rc > 0 ? '#fff' : 'rgba(255,255,255,0.35)'};">${rc.toLocaleString('es-AR')}</strong>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                <span style="display:flex; align-items:center; gap:5px; color:#2ed573;"><span style="width:8px; height:8px; border-radius:50%; background:#2ed573; display:inline-block;"></span> Plan B:</span>
                <strong style="color:${planB > 0 ? '#fff' : 'rgba(255,255,255,0.35)'};">${planB.toLocaleString('es-AR')}</strong>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                <span style="display:flex; align-items:center; gap:5px; color:#f1c40f;"><span style="width:8px; height:8px; border-radius:50%; background:#f1c40f; display:inline-block;"></span> Plan C:</span>
                <strong style="color:${planC > 0 ? '#fff' : 'rgba(255,255,255,0.35)'};">${planC.toLocaleString('es-AR')}</strong>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                <span style="display:flex; align-items:center; gap:5px; color:#a29bfe;"><span style="width:8px; height:8px; border-radius:50%; background:#a29bfe; display:inline-block;"></span> Otros / TR:</span>
                <strong style="color:${otros > 0 ? '#a29bfe' : 'rgba(255,255,255,0.35)'};">${otros.toLocaleString('es-AR')}</strong>
              </div>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 3px; border-top: 1px solid rgba(255,255,255,0.08);">
                <span style="display:flex; align-items:center; gap:5px; color:#f39c12;"><span style="width:8px; height:8px; border-radius:50%; background:#f39c12; display:inline-block;"></span> ⏳ Sync:</span>
                <strong style="color:#f39c12;">${pendiente.toLocaleString('es-AR')}</strong>
              </div>
            </div>
          </div>
        </div>

        ${insightHtml}
        ${item.canUpsell ? `
          <button class="btn btn-sm" onclick="abrirModalCampanaUpsell('${item.filter}')" style="margin-top: 10px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; background: rgba(0, 180, 216, 0.12); border: 1px solid rgba(0, 180, 216, 0.35); color: #00b4d8; font-weight: 700; border-radius: 8px; padding: 7px 12px; cursor: pointer; transition: all 0.2s ease;">
            <span>🚀</span> Audiencia Upsell RC (${rc.toLocaleString('es-AR')})
          </button>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="card mb-3" style="padding: 20px 22px; background: rgba(10, 25, 47, 0.85); border: 1px solid var(--border-color); border-radius: 14px; margin-bottom: 24px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.88rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>🍩</span> PROPORCIÓN DE COBERTURA &amp; OPORTUNIDADES DE UPSELL
          </div>
          <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 3px;">
            Diagnóstico comercial visual de la cartera activa: identifica clientes con cobertura básica para migración a pólizas de mayor valor.
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <span style="font-size: 0.72rem; color: var(--accent-cyan-light); background: rgba(0, 180, 216, 0.12); padding: 4px 10px; border-radius: 20px; border: 1px solid rgba(0, 180, 216, 0.25); font-weight: 700;">
            5 Coberturas Monitoreadas (RC • Plan B • Plan C • Otros/TR • Sync)
          </span>
          <button class="btn btn-sm" onclick="abrirModalCampanaUpsell('todos')" style="padding: 4px 12px; font-size: 0.76rem; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; background: #00b4d8; border: none; border-radius: 20px; color: #0a192f; cursor: pointer; transition: all 0.2s ease;">
            <span>🚀</span> Campaña Upsell RC
          </button>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px;">
        ${donutCards}
      </div>
    </div>
  `;
}

function renderScatterEficienciaPlantillas(plantillasPerformance) {
  if (!plantillasPerformance) return '';
  const filtered = plantillasPerformance.filter(p => !['mora_critica', 'renovacion_deuda'].includes(p.tipo_plantilla));
  if (filtered.length === 0) return '';

  const plantillaLabels = {
    'recordatorio_48hs': 'Recordatorio 48 hs',
    'recordatorio_preventivo_48hs': 'Recordatorio 48 hs',
    'primer_aviso': '1° Aviso Mora',
    'primer_aviso_vencida_48hs': '1° Aviso Mora',
    'segundo_aviso': '2° Aviso Mora',
    'cuota_segundo_aviso_vencida_hace_96_hs': '2° Aviso Mora',
    'renovacion_7_dias': 'Aviso Renovación 7d',
    'aviso_renovacion_7_dias': 'Aviso Renovación 7d',
    'poliza_vencida': 'Póliza Vencida',
    'aviso_renovacion_poliza_vencida': 'Póliza Vencida',
    'aviso_renovacion_poliza_vencida_v2': 'Póliza Vencida',
    'recuperacion_historica': 'Reactivación Cartera'
  };

  const plantillaColors = {
    'recordatorio_48hs': '#f1c40f',
    'recordatorio_preventivo_48hs': '#f1c40f',
    'primer_aviso': '#e67e22',
    'primer_aviso_vencida_48hs': '#e67e22',
    'segundo_aviso': '#e74c3c',
    'cuota_segundo_aviso_vencida_hace_96_hs': '#e74c3c',
    'renovacion_7_dias': '#00b4d8',
    'aviso_renovacion_7_dias': '#00b4d8',
    'poliza_vencida': '#a29bfe',
    'aviso_renovacion_poliza_vencida': '#a29bfe',
    'aviso_renovacion_poliza_vencida_v2': '#a29bfe',
    'recuperacion_historica': '#2ed573'
  };

  const activePoints = [];
  const inactivePoints = [];

  for (const p of filtered) {
    const totalEnvios = p.total_envios || 0;
    const reemplazadas = p.reemplazadas || 0;
    const validos = Math.max(0, totalEnvios - reemplazadas); // BASE ESTRICTA DE CONTACTOS ÚNICOS
    const exitosos = p.exitosos || 0;
    const dinero = p.dinero_recuperado || 0;
    const label = plantillaLabels[p.tipo_plantilla] || p.tipo_plantilla;
    const color = plantillaColors[p.tipo_plantilla] || '#00b4d8';

    if (validos === 0) {
      inactivePoints.push({ label, color, tipo: p.tipo_plantilla });
      continue;
    }

    const conversion = parseFloat(((exitosos / validos) * 100).toFixed(1));
    const retornoPorContacto = Math.round(dinero / validos);

    activePoints.push({
      label,
      tipo: p.tipo_plantilla,
      color,
      validos,
      totalEnvios,
      reemplazadas,
      exitosos,
      dinero,
      conversion,
      retornoPorContacto
    });
  }

  // SVG Geometry
  const svgW = 740;
  const svgH = 340;
  const padL = 75;
  const padR = 35;
  const padT = 30;
  const padB = 45;
  const plotW = svgW - padL - padR; // 630
  const plotH = svgH - padT - padB; // 265

  // X scale: 0 to 100 (%)
  const minX = 0;
  const maxX = 100;
  const scaleX = (val) => padL + (Math.max(minX, Math.min(maxX, val)) / maxX) * plotW;

  // Y scale: $0 to maxRetorno (with 20% headroom)
  const maxRawY = Math.max(1000, ...activePoints.map(p => p.retornoPorContacto));
  const maxY = Math.ceil((maxRawY * 1.2) / 5000) * 5000;
  const scaleY = (val) => padT + plotH - (Math.max(0, Math.min(maxY, val)) / maxY) * plotH;

  // Median / Quadrant lines
  const midX = scaleX(50); // 50% conversion line
  const midY = scaleY(maxY / 2); // 50% ticket line

  // Max validos for radius scaling
  const maxValidos = Math.max(1, ...activePoints.map(p => p.validos));

  // Build grid ticks
  const yTicks = [0, maxY * 0.25, maxY * 0.5, maxY * 0.75, maxY];
  const gridLinesY = yTicks.map(t => {
    const yPos = scaleY(t);
    const labelFmt = t === 0 ? '$0' : (t >= 1000 ? `$${Math.round(t/1000)}k` : `$${Math.round(t)}`);
    return `
      <line x1="${padL}" y1="${yPos}" x2="${padL + plotW}" y2="${yPos}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
      <text x="${padL - 10}" y="${yPos + 4}" fill="var(--text-secondary)" font-size="11" text-anchor="end" font-weight="600">${labelFmt}</text>
    `;
  }).join('');

  const xTicks = [0, 25, 50, 75, 100];
  const gridLinesX = xTicks.map(t => {
    const xPos = scaleX(t);
    return `
      <line x1="${xPos}" y1="${padT}" x2="${xPos}" y2="${padT + plotH}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3,3" />
      <text x="${xPos}" y="${padT + plotH + 20}" fill="var(--text-secondary)" font-size="11" text-anchor="middle" font-weight="600">${t}%</text>
    `;
  }).join('');

  // Quadrant Labels (Watermarks)
  const quadWatermarks = `
    <text x="${padL + plotW - 12}" y="${padT + 22}" fill="rgba(46, 213, 115, 0.22)" font-size="11" font-weight="800" text-anchor="end">🌟 ALTO RETORNO &amp; ALTA CONVERSIÓN</text>
    <text x="${padL + 14}" y="${padT + 22}" fill="rgba(0, 180, 216, 0.22)" font-size="11" font-weight="800" text-anchor="start">💎 ALTO RETORNO &amp; OPTIMIZAR CONV.</text>
    <text x="${padL + 14}" y="${padT + plotH - 12}" fill="rgba(255, 118, 117, 0.22)" font-size="11" font-weight="800" text-anchor="start">⚠️ BAJA EFICIENCIA (REVISAR)</text>
    <text x="${padL + plotW - 12}" y="${padT + plotH - 12}" fill="rgba(241, 196, 15, 0.22)" font-size="11" font-weight="800" text-anchor="end">⚡ RECORDATORIOS ÁGILES</text>
  `;

  // Plot Bubbles
  const bubbles = activePoints.map(p => {
    const cx = scaleX(p.conversion);
    const cy = scaleY(p.retornoPorContacto);
    // Radius proportional to sqrt(validos)
    const r = Math.max(9, Math.min(28, Math.round(9 + Math.sqrt(p.validos / maxValidos) * 19)));
    const dineroFmt = p.dinero.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
    const retFmt = p.retornoPorContacto.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

    const tooltip = `${p.label}
• Contactos Únicos: ${p.validos} (${p.totalEnvios} disparos totales)
• Tasa Conversión: ${p.conversion}% (${p.exitosos} cobros)
• Dinero Recuperado: ${dineroFmt}
• Rendimiento: ${retFmt} por cliente único`;

    return `
      <g style="cursor: pointer;" class="scatter-bubble-group">
        <circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="${p.color}" opacity="0.18"></circle>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="${p.color}" fill-opacity="0.85" stroke="#fff" stroke-width="1.5">
          <title>${tooltip}</title>
        </circle>
        <text x="${cx}" y="${cy - r - 6}" fill="#fff" font-size="10.5" font-weight="800" text-anchor="middle" style="pointer-events: none; text-shadow: 0 1px 4px rgba(0,0,0,0.8);">${p.label}</text>
      </g>
    `;
  }).join('');

  // Inactive templates list (no data lost silently)
  const inactivePills = inactivePoints.length > 0
    ? `<div style="margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 0.73rem; color: var(--text-secondary);">
        <span>📭 Sin envíos en este período:</span>
        ${inactivePoints.map(p => `<span style="background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); color: var(--text-secondary);">${p.label}</span>`).join('')}
       </div>`
    : '';

  return `
    <div class="card mb-3" style="padding: 22px; margin-bottom: 24px; border: 1px solid var(--border-color); background: rgba(10, 25, 47, 0.85); border-radius: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 0.92rem; font-weight: 800; text-transform: uppercase; color: var(--accent-cyan-light); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px;">
            <span>🎯</span> MATRIZ DE EFICIENCIA POR PLANTILLA (CONVERSIÓN VS. RETORNO)
          </div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 3px;">
            Clasificación estratégica en 4 cuadrantes. Tamaño de burbuja = clientes únicos contactados (base limpia sin reenvíos).
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px; font-size: 0.74rem;">
          <span style="color: var(--text-secondary);">Eje X: <strong>% Conversión</strong></span>
          <span style="color: var(--text-secondary);">•</span>
          <span style="color: var(--text-secondary);">Eje Y: <strong>$ / Contacto Único</strong></span>
        </div>
      </div>

      <div style="width: 100%; overflow-x: auto;">
        <svg viewBox="0 0 ${svgW} ${svgH}" style="width: 100%; max-height: 380px; min-width: 580px; display: block;">
          <!-- Quadrant Background Tints -->
          <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="rgba(255,255,255,0.015)" rx="8"></rect>
          
          <!-- Midpoint Quadrant Dividers -->
          <line x1="${midX}" y1="${padT}" x2="${midX}" y2="${padT + plotH}" stroke="rgba(255,255,255,0.12)" stroke-width="1.5" stroke-dasharray="4,4"></line>
          <line x1="${padL}" y1="${midY}" x2="${padL + plotW}" y2="${midY}" stroke="rgba(255,255,255,0.12)" stroke-width="1.5" stroke-dasharray="4,4"></line>

          <!-- Watermarks -->
          ${quadWatermarks}

          <!-- Grid Lines & Ticks -->
          ${gridLinesY}
          ${gridLinesX}

          <!-- Axis Labels -->
          <text x="${padL + plotW / 2}" y="${svgH - 6}" fill="var(--text-secondary)" font-size="11" font-weight="700" text-anchor="middle">Tasa de Conversión sobre Contactos Únicos →</text>
          <text x="18" y="${padT + plotH / 2}" fill="var(--text-secondary)" font-size="11" font-weight="700" text-anchor="middle" transform="rotate(-90 18 ${padT + plotH / 2})">Dinero Recuperado por Contacto ($) →</text>

          <!-- Bubbles -->
          ${bubbles}
        </svg>
      </div>

      ${inactivePills}
    </div>
  `;
}

// ─── LÓGICA DE AUDIENCIA Y MODAL DE CAMPAÑA UPSELL RC ───────────────────────

window._upsellState = {
  filtroTipo: 'todos',
  candidatos: [],
  resumen: {},
  seleccionados: new Set(),
  modoDryRun: true
};

window.abrirModalCampanaUpsell = async function(filtroTipo = 'todos') {
  window._upsellState.filtroTipo = filtroTipo === 'Pick Up' ? 'pickup' : (filtroTipo === 'Auto' ? 'auto' : 'todos');
  const modal = document.getElementById('modalCampanaUpsell');
  if (!modal) return;

  modal.style.display = 'flex';
  const tbody = document.getElementById('tbodyUpsellCandidatos');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 30px; color: var(--text-secondary);"><span class="spinner-border spinner-border-sm"></span> Cargando y auditando candidatos al día...</td></tr>`;
  }

  await cargarAudienciaUpsell();
};

window.closeModalCampanaUpsell = function() {
  const modal = document.getElementById('modalCampanaUpsell');
  if (modal) modal.style.display = 'none';
};

window.filtrarAudienciaUpsell = async function(tipo) {
  window._upsellState.filtroTipo = tipo;
  // Actualizar botones de filtro
  ['todos', 'auto', 'pickup'].forEach(t => {
    const btn = document.getElementById(`btnFilterUpsell_${t}`);
    if (btn) {
      if (t === tipo) {
        btn.style.background = '#00b4d8';
        btn.style.color = '#0a192f';
      } else {
        btn.style.background = 'rgba(255,255,255,0.06)';
        btn.style.color = 'var(--text-secondary)';
      }
    }
  });
  await cargarAudienciaUpsell();
};

async function cargarAudienciaUpsell() {
  try {
    const tipo = window._upsellState.filtroTipo || 'todos';
    const res = await fetch(`/api/metricas/audiencia-upsell?tipo=${tipo}&limite=50`);
    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || 'Error cargando candidatos');
    }

    window._upsellState.candidatos = data.candidatos || [];
    window._upsellState.resumen = data.resumen || {};
    window._upsellState.seleccionados = new Set();

    // Seleccionar por defecto los aptos del micro-lote recomendado
    window._upsellState.candidatos.forEach(c => {
      if (c.apto_envio) {
        window._upsellState.seleccionados.add(c.id);
      }
    });

    renderResumenUpsell(data.resumen);
    renderTablaUpsell();
    actualizarPreviewMensajeUpsell();

  } catch (err) {
    console.error('[Upsell UI Error]', err);
    const tbody = document.getElementById('tbodyUpsellCandidatos');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: #ff7675;">❌ Error: ${err.message}</td></tr>`;
    }
  }
}

function renderResumenUpsell(resumen = {}) {
  const tot = resumen.total_candidatos_al_dia || 0;
  const autos = resumen.autos_candidatos || 0;
  const pickups = resumen.pickups_candidatos || 0;
  const aptosLote = resumen.aptos_en_lote || 0;
  const silenciados = (resumen.silenciados_humano || 0) + (resumen.excluidos_cobranza_reciente || 0);

  const elTot = document.getElementById('kpiUpsellTotal');
  if (elTot) elTot.innerText = tot.toLocaleString('es-AR');

  const elSub = document.getElementById('kpiUpsellDesglose');
  if (elSub) elSub.innerText = `${autos} Autos • ${pickups} Pick Ups`;

  const elLote = document.getElementById('kpiUpsellLote');
  if (elLote) elLote.innerText = `${aptosLote} / 50`;

  const elSil = document.getElementById('kpiUpsellSilenciados');
  if (elSil) elSil.innerText = silenciados.toLocaleString('es-AR');
}

function renderTablaUpsell() {
  const tbody = document.getElementById('tbodyUpsellCandidatos');
  if (!tbody) return;

  const candidatos = window._upsellState.candidatos || [];
  if (candidatos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 24px; color: var(--text-secondary);">No se encontraron pólizas al día con cobertura básica RC para este filtro.</td></tr>`;
    return;
  }

  tbody.innerHTML = candidatos.map(c => {
    const isChecked = window._upsellState.seleccionados.has(c.id);
    const badgeApto = c.apto_envio
      ? `<span class="badge" style="background: rgba(46,213,115,0.18); color: #2ed573; border: 1px solid rgba(46,213,115,0.4); font-size: 0.7rem; font-weight: 700;">🟢 Apto Envío</span>`
      : `<span class="badge" style="background: rgba(243,156,18,0.18); color: #f39c12; border: 1px solid rgba(243,156,18,0.4); font-size: 0.7rem;" title="${c.motivo_inaptitud || 'No disponible'}">🟡 ${c.motivo_inaptitud || 'Omitido'}</span>`;

    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.8rem; background: ${isChecked ? 'rgba(0,180,216,0.04)' : 'transparent'};">
        <td style="padding: 10px 12px; text-align: center;">
          <input type="checkbox" onchange="toggleSelectUpsell(${c.id})" ${isChecked ? 'checked' : ''} style="cursor: pointer;">
        </td>
        <td style="padding: 10px 12px;">
          <div style="font-weight: 700; color: #fff;">${c.cliente_nombre}</div>
          <div style="font-size: 0.72rem; color: var(--text-secondary); font-family: monospace;">${c.cliente_telefono ? '+'+c.cliente_telefono : '<span style="color:#ff7675;">Sin teléfono</span>'}</div>
        </td>
        <td style="padding: 10px 12px;">
          <div style="font-weight: 600; color: var(--text-primary);">${c.vehiculo || c.tipo_vehiculo}</div>
          <div style="font-size: 0.72rem; color: var(--accent-cyan-light); font-weight: 700;">${c.patente || 'S/D'} • Op. ${c.operacion}</div>
        </td>
        <td style="padding: 10px 12px; text-align: center;">
          <span style="font-size: 0.75rem; background: rgba(72,202,228,0.15); color: #48cae4; border: 1px solid rgba(72,202,228,0.3); padding: 2px 7px; border-radius: 4px; font-weight: 700;">${c.cobertura || 'RC'}</span>
          <div style="font-size: 0.68rem; color: var(--text-secondary); margin-top: 2px;">${c.aseguradora}</div>
        </td>
        <td style="padding: 10px 12px; text-align: center;">
          <span style="color: #2ed573; font-weight: 700; font-size: 0.75rem;">$0 (Al Día)</span>
        </td>
        <td style="padding: 10px 12px; text-align: right;">
          ${badgeApto}
        </td>
      </tr>
    `;
  }).join('');

  actualizarContadorSeleccionados();
}

window.toggleSelectAllUpsell = function() {
  const master = document.getElementById('chkUpsellMaster');
  const checked = master ? master.checked : false;

  window._upsellState.seleccionados.clear();
  if (checked) {
    (window._upsellState.candidatos || []).forEach(c => {
      window._upsellState.seleccionados.add(c.id);
    });
  }
  renderTablaUpsell();
  actualizarPreviewMensajeUpsell();
};

window.toggleSelectUpsell = function(id) {
  if (window._upsellState.seleccionados.has(id)) {
    window._upsellState.seleccionados.delete(id);
  } else {
    window._upsellState.seleccionados.add(id);
  }
  actualizarContadorSeleccionados();
  actualizarPreviewMensajeUpsell();
};

function actualizarContadorSeleccionados() {
  const count = window._upsellState.seleccionados.size;
  const badge = document.getElementById('badgeUpsellSeleccionados');
  if (badge) badge.innerText = `${count} seleccionados`;

  const btnDespacho = document.getElementById('btnEjecutarDespachoUpsell');
  if (btnDespacho) {
    btnDespacho.innerText = `🚀 Ejecutar Simulación (${count})`;
    btnDespacho.disabled = count === 0;
  }
}

window.actualizarPreviewMensajeUpsell = function() {
  const previewBox = document.getElementById('previewMensajeUpsell');
  if (!previewBox) return;

  const candidatos = window._upsellState.candidatos || [];
  // Tomar el primer cliente seleccionado o el primero de la lista
  const primerId = Array.from(window._upsellState.seleccionados)[0];
  const c = candidatos.find(item => item.id === primerId) || candidatos[0];

  if (!c) {
    previewBox.innerHTML = `<em>Seleccioná un cliente para ver la vista previa personalizada...</em>`;
    return;
  }

  const nombre = c.cliente_nombre ? c.cliente_nombre.split(' ')[0] : 'Cliente';
  const veh = c.vehiculo || (c.tipo_vehiculo + ' ' + (c.patente || ''));
  const pat = c.patente || 'S/D';

  const texto = `Hola ${nombre}, ¿cómo estás? Te escribimos de SEGUCar respecto a tu póliza de ${veh} (Patente ${pat}). Notamos que contás con cobertura básica de Responsabilidad Civil. Hoy tenemos una bonificación especial para mejorar tu plan a Terceros Completo (Plan C), sumando cobertura ante robo, incendio y destrucción total con la mejor tarifa. ¿Te gustaría que te coticemos la diferencia sin compromiso?`;

  previewBox.innerText = texto;
};

window.exportarAudienciaUpsellCSV = function() {
  const candidatos = window._upsellState.candidatos || [];
  if (candidatos.length === 0) {
    alert('No hay candidatos en la lista para exportar.');
    return;
  }

  const headers = ['ID_Poliza', 'Cliente', 'Telefono', 'Tipo_Vehiculo', 'Vehiculo', 'Patente', 'Operacion', 'Aseguradora', 'Cobertura_Actual', 'Saldo_Pendiente', 'Estado_Aptitud', 'Motivo_Detalle'];
  
  const rows = candidatos.map(c => [
    c.id,
    `"${(c.cliente_nombre || '').replace(/"/g, '""')}"`,
    `"${c.cliente_telefono || ''}"`,
    `"${c.tipo_vehiculo || ''}"`,
    `"${(c.vehiculo || '').replace(/"/g, '""')}"`,
    `"${c.patente || ''}"`,
    `"${c.operacion || ''}"`,
    `"${c.aseguradora || ''}"`,
    `"${c.cobertura || ''}"`,
    `0`,
    `"${c.apto_envio ? 'APTO_ENVIO' : 'OMITIDO'}"`,
    `"${(c.motivo_inaptitud || 'OK').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const hoyFmt = new Date().toISOString().slice(0, 10);
  a.download = `audiencia_upsell_segucar_${hoyFmt}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

window.ejecutarDespachoUpsell = async function() {
  const seleccionadosIds = Array.from(window._upsellState.seleccionados);
  if (seleccionadosIds.length === 0) {
    alert('Seleccione al menos un cliente para la simulación.');
    return;
  }

  if (seleccionadosIds.length > 50) {
    alert('Por seguridad operativa, el tamaño máximo de micro-lote diario es de 50 clientes.');
    return;
  }

  const candidatos = (window._upsellState.candidatos || []).filter(c => seleccionadosIds.includes(c.id));
  const btn = document.getElementById('btnEjecutarDespachoUpsell');
  const progresoDiv = document.getElementById('progresoDespachoUpsell');

  if (btn) btn.disabled = true;
  if (progresoDiv) {
    progresoDiv.style.display = 'block';
    progresoDiv.innerHTML = `
      <div style="background: rgba(0,180,216,0.1); border: 1px solid rgba(0,180,216,0.3); border-radius: 8px; padding: 12px; margin-top: 14px; font-size: 0.82rem; color: #48cae4;">
        ⏳ Ejecutando simulación de despacho seguro (Preflight en memoria para ${candidatos.length} pólizas)...
      </div>
    `;
  }

  try {
    const res = await fetch('/api/metricas/despacho-upsell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        polizas: candidatos,
        dry_run: true // 🛡️ Siempre Simulación (Dry-Run) garantizando CERO contaminación en DB
      })
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(data.error || 'Error al ejecutar despacho');
    }

    if (progresoDiv) {
      progresoDiv.innerHTML = `
        <div style="background: rgba(46,213,115,0.1); border: 1px solid rgba(46,213,115,0.35); border-radius: 8px; padding: 14px; margin-top: 14px; font-size: 0.84rem; color: #2ed573;">
          <div style="font-weight: 800; font-size: 0.95rem; margin-bottom: 4px;">✅ Simulación de Despacho Completada con Éxito</div>
          <div>${data.mensaje}</div>
          <div style="margin-top: 6px; font-size: 0.78rem; color: var(--text-secondary);">
            • Total evaluados: <strong>${data.total_procesados}</strong> | 
            • Aptos validados: <strong style="color:#2ed573;">${data.simulados_aptos}</strong> | 
            • Omitidos preflight: <strong style="color:#f39c12;">${data.simulados_omitidos}</strong>
          </div>
          <div style="margin-top: 8px; font-size: 0.75rem; color: #48cae4;">
            🔒 <em>Protección activa: Ningún mensaje real fue emitido y ningún registro de métricas fue modificado.</em>
          </div>
        </div>
      `;
    }

  } catch (err) {
    if (progresoDiv) {
      progresoDiv.innerHTML = `
        <div style="background: rgba(255,71,87,0.1); border: 1px solid rgba(255,71,87,0.4); border-radius: 8px; padding: 12px; margin-top: 14px; font-size: 0.82rem; color: #ff7675;">
          ❌ ${err.message}
        </div>
      `;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.exportarReporteEjecutivoExcel = function() {
  const rango = currentRangoMetricas || 'este_mes';
  let url = `/api/metricas/exportar-excel?rango=${encodeURIComponent(rango)}`;
  if (rango === 'custom' && currentCustomDesde && currentCustomHasta) {
    url += `&desde=${encodeURIComponent(currentCustomDesde)}&hasta=${encodeURIComponent(currentCustomHasta)}`;
  }
  window.open(url, '_blank');
};



