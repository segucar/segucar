/**
 * app.js - SEGUCar Dashboard Logic
 */

let state = {
  clients: [],
  templates: [],
  filters: {
    search: '',
    tipo: '',
    estado: ''
  },
  sort: {
    by: 'nombre',
    dir: 'ASC'
  },
  pagination: {
    page: 1,
    limit: 50,
    total: 0,
    pages: 1
  },
  activeView: 'dashboard'
};

const getEl = (id) => document.getElementById(id);

const COLUMN_DEFAULTS = {
  nombre: true,
  telefono: true,
  patente: true,
  operacion: true,
  vehiculo: true,
  nro_cuota: true,
  venc_cuota: true,
  importe: true,
  dias_mora: true,
  fin_vigencia: true,
  estado_poliza: true,
  accion_cobranza: true,
  accion_poliza: true,
  acciones: true
};

const COLUMN_LABELS = {
  nombre: 'Cliente',
  telefono: 'Teléfono',
  patente: 'Patente',
  operacion: 'Póliza N°',
  vehiculo: 'Vehículo',
  nro_cuota: 'N° Cuota',
  venc_cuota: 'Vencimiento',
  importe: 'Importe Pendiente',
  dias_mora: 'Días de Mora',
  fin_vigencia: 'Fin Vigencia Póliza',
  estado_poliza: 'Estado Póliza',
  accion_cobranza: 'Acción Cobranza',
  accion_poliza: 'Acción Póliza',
  acciones: 'Acciones'
};

function getColumnPreferences() {
  const stored = localStorage.getItem('columnPreferences');
  if (stored) {
    try {
      return { ...COLUMN_DEFAULTS, ...JSON.parse(stored) };
    } catch (e) {
      return COLUMN_DEFAULTS;
    }
  }
  return COLUMN_DEFAULTS;
}

function saveColumnPreferences(prefs) {
  localStorage.setItem('columnPreferences', JSON.stringify(prefs));
}

function toggleColumnSelector(event) {
  if (event) event.stopPropagation();
  const dropdown = getEl('columnSelectorDropdown');
  if (dropdown) {
    dropdown.classList.toggle('hidden');
    if (!dropdown.classList.contains('hidden')) {
      renderColumnCheckboxes();
    }
  }
}

function renderColumnCheckboxes() {
  const container = getEl('columnSelectorCheckboxes');
  if (!container) return;

  const prefs = getColumnPreferences();
  const isCobranza = state.activeView === 'cobranza';

  const activeCols = isCobranza 
    ? ['nombre', 'telefono', 'patente', 'operacion', 'vehiculo', 'nro_cuota', 'venc_cuota', 'importe', 'dias_mora', 'fin_vigencia', 'accion_cobranza', 'acciones']
    : ['nombre', 'telefono', 'patente', 'operacion', 'vehiculo', 'venc_cuota', 'estado_poliza', 'accion_poliza', 'acciones'];

  container.innerHTML = activeCols.map(key => `
    <label style="display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; color: #e8e8f0; font-size: 0.88rem; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; user-select: none;" onmouseover="this.style.background='rgba(255,255,255,0.06)'; this.style.color='#00b4d8';" onmouseout="this.style.background='transparent'; this.style.color='#e8e8f0';">
      <input type="checkbox" id="col_chk_${key}" ${prefs[key] ? 'checked' : ''} onchange="handleColumnToggle('${key}', this.checked)" style="accent-color: #00b4d8; width: 16px; height: 16px; cursor: pointer; margin: 0;">
      <span style="font-weight: 500;">${COLUMN_LABELS[key]}</span>
    </label>
  `).join('');
}

function handleColumnToggle(key, isChecked) {
  const prefs = getColumnPreferences();
  prefs[key] = isChecked;
  saveColumnPreferences(prefs);
  updateTableHeader();
  renderTable();
}

document.addEventListener('click', (e) => {
  const dropdown = getEl('columnSelectorDropdown');
  const btn = getEl('btnColumnSelector');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!dropdown.contains(e.target) && e.target !== btn) {
      dropdown.classList.add('hidden');
    }
  }
});

function switchView(viewName) {
  state.activeView = viewName;

  ['navDashboard', 'navCobranza', 'navRenovaciones', 'navMetricas'].forEach(id => {
    const el = getEl(id);
    if (el) el.classList.remove('active');
  });

  if (viewName === 'dashboard') getEl('navDashboard')?.classList.add('active');
  else if (viewName === 'cobranza') getEl('navCobranza')?.classList.add('active');
  else if (viewName === 'renovaciones') getEl('navRenovaciones')?.classList.add('active');
  else if (viewName === 'metricas') getEl('navMetricas')?.classList.add('active');

  const vDash = getEl('viewDashboard');
  const vCob = getEl('viewCobranza');
  const vRen = getEl('viewRenovaciones');
  const vMet = getEl('viewMetricas');
  const tblSection = getEl('mainTableSection');

  if (vDash) vDash.style.display = viewName === 'dashboard' ? 'block' : 'none';
  if (vCob) vCob.style.display = viewName === 'cobranza' ? 'block' : 'none';
  if (vRen) vRen.style.display = viewName === 'renovaciones' ? 'block' : 'none';
  if (vMet) vMet.style.display = viewName === 'metricas' ? 'block' : 'none';

  if (tblSection) {
    tblSection.style.display = (viewName === 'dashboard' || viewName === 'metricas') ? 'none' : 'block';
  }

  if (viewName === 'metricas') {
    if (typeof fetchMetricas === 'function') fetchMetricas();
    return;
  }

  if (viewName === 'cobranza') {
    // Default sort: prioridad urgente primero
    if (state.sort.by === 'nombre' || state.sort.by === 'prioridad_cobranza') {
      state.sort.by = 'vencimiento';
      state.sort.dir = 'ASC';
    }
  } else if (viewName === 'renovaciones') {
    // Default sort: pólizas vencidas primero
    if (state.sort.by === 'nombre') {
      state.sort.by = 'prioridad_poliza';
      state.sort.dir = 'ASC';
    }
  }

  if (viewName !== 'dashboard') {
    fetchClientes();
  }
}

function openViewWithFilter(viewName, filterVal) {
  switchView(viewName);
  filterByState(filterVal);
}

function handleSort(col) {
  if (state.sort.by === col) {
    state.sort.dir = state.sort.dir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    state.sort.by = col;
    state.sort.dir = 'ASC';
  }

  const cols = ['nombre', 'telefono', 'patente', 'operacion', 'vehiculo', 'tipo', 'vencimiento', 'estado', 'cuota', 'prioridad_cobranza', 'prioridad_poliza', 'nro_cuota', 'importe', 'dias_mora', 'fin_vigencia'];
  cols.forEach(c => {
    const el = getEl(`sort_icon_${c}`);
    if (el) {
      if (c === state.sort.by) {
        el.innerText = state.sort.dir === 'ASC' ? '▲' : '▼';
        el.className = 'sort-icon active';
      } else {
        el.innerText = '⇅';
        el.className = 'sort-icon';
      }
    }
  });

  state.pagination.page = 1;
  fetchClientes();
}

function startApp() {
  setupEventListeners();
  fetchStats();
  
  const targetView = localStorage.getItem('targetView');
  if (targetView) {
    localStorage.removeItem('targetView');
    switchView(targetView);
  } else {
    fetchClientes();
  }

  const targetSync = localStorage.getItem('targetSyncNRE');
  if (targetSync) {
    localStorage.removeItem('targetSyncNRE');
    setTimeout(() => {
      triggerSyncNRE();
    }, 500);
  }

  fetchTemplates();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

function exportarExcel() {
  showToast('Generando reporte Excel multi-solapa...', 'info');
  window.open('/api/exportar-excel', '_blank');
}


function setupEventListeners() {
  const searchInput = getEl('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', debounce((e) => {
      state.filters.search = e.target.value;
      state.pagination.page = 1;
      fetchClientes();
    }, 300));
  }

  const filterTipo = getEl('filterTipo');
  if (filterTipo) {
    filterTipo.addEventListener('change', (e) => {
      state.filters.tipo = e.target.value;
      state.pagination.page = 1;
      fetchClientes();
    });
  }

  const filterEstado = getEl('filterEstado');
  if (filterEstado) {
    filterEstado.addEventListener('change', (e) => {
      state.filters.estado = e.target.value;
      state.pagination.page = 1;
      fetchClientes();
    });
  }

  const filterFechaDesde = getEl('filterFechaDesde');
  if (filterFechaDesde) {
    filterFechaDesde.addEventListener('change', (e) => {
      state.filters.fecha_desde = e.target.value;
      state.pagination.page = 1;
      fetchClientes();
    });
  }

  const filterFechaHasta = getEl('filterFechaHasta');
  if (filterFechaHasta) {
    filterFechaHasta.addEventListener('change', (e) => {
      state.filters.fecha_hasta = e.target.value;
      state.pagination.page = 1;
      fetchClientes();
    });
  }

  const fabAddClient = getEl('fabAddClient');
  if (fabAddClient) fabAddClient.addEventListener('click', () => openModal());

  const closeModalBtn = getEl('closeModalBtn');
  if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);

  const cancelModalBtn = getEl('cancelModalBtn');
  if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeModal);

  const clientForm = getEl('clientForm');
  if (clientForm) clientForm.addEventListener('submit', handleClientSubmit);

  document.addEventListener('click', () => {
    document.querySelectorAll('.wa-popover').forEach(p => p.classList.remove('active'));
  });
}

function filterByState(estadoVal) {
  const filterEstado = getEl('filterEstado');
  if (filterEstado) {
    filterEstado.value = estadoVal;
  }
  state.filters.estado = estadoVal;

  // Actualizar indicador visual activo (.active) en las tarjetas de estado superiores
  document.querySelectorAll('.action-card-btn').forEach(btn => {
    btn.classList.remove('active');
    const onclickAttr = btn.getAttribute('onclick') || '';
    if (onclickAttr.includes(`filterByState('${estadoVal}')`) || (estadoVal === '' && onclickAttr.includes("filterByState('')"))) {
      btn.classList.add('active');
    }
  });

  const notice = getEl('activeFilterNotice');
  const label = getEl('activeFilterLabel');
  const summary = getEl('activeFilterHumanSummary');

  if (notice && label && summary) {
    if (estadoVal === '') {
      notice.style.display = 'none';
    } else {
      notice.style.display = 'flex';
      if (estadoVal === 'vence_48h') {
        label.innerText = '💳 GESTIÓN DE CUOTAS → 🟡 Recordatorio 48 hs (Preventivo)';
        summary.innerText = '— Cuotas con vencimiento exacto en 48 hs.';
      } else if (estadoVal === 'vencio_48h') {
        label.innerText = '💳 GESTIÓN DE CUOTAS → 🟠 Primer Aviso (Vencida hace 48 hs)';
        summary.innerText = '— 1 cuota impaga (48 hs vencida).';
      } else if (estadoVal === 'vencio_96h') {
        label.innerText = '💳 GESTIÓN DE CUOTAS → 🔴 Segundo Aviso (Vencida hace 96 hs)';
        summary.innerText = '— 1 cuota impaga (96 hs / Período de gracia).';
      } else if (estadoVal === 'cuota_deuda') {
        label.innerText = '💳 GESTIÓN DE CUOTAS → 🚨 Mora Crítica (+96 hs / Perdió Período de Gracia)';
        summary.innerText = '— Cobertura suspendida / 2+ cuotas o >96 hs.';
      } else if (estadoVal === 'por_vencer') {
        label.innerText = '🛡️ GESTIÓN DE PÓLIZAS → 📄 Aviso Renovación (7 Días)';
        summary.innerText = '— Propuesta de renovación / Vence en 7 días.';
      } else if (estadoVal === 'poliza_vencida') {
        label.innerText = '🛡️ GESTIÓN DE PÓLIZAS → ⚫ Póliza Vencida';
        summary.innerText = '— Vencimiento en los últimos 30 días.';
      } else if (estadoVal === 'vigente') {
        label.innerText = '🛡️ GESTIÓN DE PÓLIZAS → 🟢 Contrato Vigente';
        summary.innerText = '— Vence en más de 7 días.';
      }
    }
  }

  state.pagination.page = 1;
  fetchClientes();
}

function resetFilters() {
  state.filters = { search: '', tipo: '', estado: '', fecha_desde: '', fecha_hasta: '' };
  
  if (getEl('searchInput')) getEl('searchInput').value = '';
  if (getEl('filterTipo')) getEl('filterTipo').value = '';
  if (getEl('filterEstado')) getEl('filterEstado').value = '';
  if (getEl('filterFechaDesde')) getEl('filterFechaDesde').value = '';
  if (getEl('filterFechaHasta')) getEl('filterFechaHasta').value = '';

  document.querySelectorAll('.action-card-btn').forEach(btn => btn.classList.remove('active'));

  const notice = getEl('activeFilterNotice');
  if (notice) notice.style.display = 'none';

  state.pagination.page = 1;
  fetchClientes();
  showToast('Filtros reiniciados', 'info');
}

// ─── API FETCHING ─────────────────────────────────────────────────────────

async function fetchStats() {
  try {
    const res = await fetch('/api/dashboard/stats');
    const stats = await res.json();

    state.lastSyncDate = stats.last_sync_date || null;

    // Dashboard Executive Counters - Cobranza
    setStatValue('dashVence48', (stats.vence_48h || 0).toLocaleString('es-AR'));
    setStatValue('dashVencio48', (stats.vencio_48h || 0).toLocaleString('es-AR'));
    setStatValue('dashVencio96', (stats.vencio_96h || 0).toLocaleString('es-AR'));
    setStatValue('dashMoraCritica', (stats.mora_critica || 0).toLocaleString('es-AR'));

    // Dashboard Executive Counters - Renovaciones
    setStatValue('dashPorVencer', (stats.polizas_vencen_semana || 0).toLocaleString('es-AR'));
    setStatValue('dashPolizaVencida', (stats.polizas_vencidas || 0).toLocaleString('es-AR'));
    setStatValue('dashContratoVigente', (stats.polizas_vigentes || 0).toLocaleString('es-AR'));

    // Modular View Counters - Cobranza
    setStatValue('statAlDiaCob', (stats.al_dia || stats.total_polizas || 0).toLocaleString('es-AR'));
    setStatValue('statVence48hCob', (stats.vence_48h || 0).toLocaleString('es-AR'));
    setStatValue('statVencio48hCob', (stats.vencio_48h || 0).toLocaleString('es-AR'));
    setStatValue('statVencio96hCob', (stats.vencio_96h || 0).toLocaleString('es-AR'));
    setStatValue('statCuotasDeudaCob', (stats.mora_critica || 0).toLocaleString('es-AR'));

    // Modular View Counters - Renovaciones
    setStatValue('statPolizasVigentesRen', (stats.polizas_vigentes || 0).toLocaleString('es-AR'));
    setStatValue('statVencenSemanaRen', (stats.polizas_vencen_semana || 0).toLocaleString('es-AR'));
    setStatValue('statPolizasVencidasRen', (stats.polizas_vencidas || 0).toLocaleString('es-AR'));
    setStatValue('statRecuperarRen', (stats.total_recuperar || 0).toLocaleString('es-AR'));

    // Phone Coverage Progress Banner
    const bannerCargados = getEl('bannerCargados');
    if (bannerCargados && stats.clientes_con_telefono !== undefined) {
      const conTel = (stats.clientes_con_telefono || 0).toLocaleString('es-AR');
      const totalCli = (stats.total_clientes || 0).toLocaleString('es-AR');
      const pct = stats.cobertura_porcentaje || '0';
      bannerCargados.innerText = `${conTel} de ${totalCli} (${pct}%)`;
    }
    const bannerFaltantes = getEl('bannerFaltantes');
    if (bannerFaltantes && stats.clientes_sin_telefono !== undefined) {
      bannerFaltantes.innerText = (stats.clientes_sin_telefono || 0).toLocaleString('es-AR');
    }
    const bannerProgressBar = getEl('bannerProgressBar');
    if (bannerProgressBar && stats.cobertura_porcentaje !== undefined) {
      bannerProgressBar.style.width = `${stats.cobertura_porcentaje}%`;
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

function setStatValue(id, val) {
  const el = getEl(id);
  if (el) el.innerText = val;
}

async function fetchTemplates() {
  try {
    const res = await fetch('/api/plantillas');
    const data = await res.json();
    state.templates = data.map(t => ({
      id: t.id,
      name: t.nombre,
      template: t.mensaje,
      tipo: t.tipo,
      activa: t.activa
    })).filter(t => t.activa);
  } catch (err) {
    console.error('Error fetching templates:', err);
    state.templates = [];
  }
}

function getSaldoExigible(poliza) {
  if (!poliza) return 0;
  if (poliza.saldo_exigible !== undefined && poliza.saldo_exigible !== null) {
    return parseFloat(poliza.saldo_exigible) || 0;
  }
  if (poliza.cuotas_historial) {
    try {
      const hist = typeof poliza.cuotas_historial === 'string' ? JSON.parse(poliza.cuotas_historial) : poliza.cuotas_historial;
      if (Array.isArray(hist) && hist.length > 0) {
        const cleanVenc = String(poliza.fecha_vencimiento || '').split('T')[0].split(' ')[0];
        if (cleanVenc) {
          const dueCuotas = hist.filter(c => {
            if (!c) return false;
            const vto = String(c.vto_cuota || c.vencimiento || '').split('T')[0].split(' ')[0];
            const s = parseFloat(c.saldo_cli || c.importe || 0);
            return s > 0 && vto && vto <= cleanVenc;
          });
          if (dueCuotas.length > 0) {
            return dueCuotas.reduce((sum, c) => sum + (parseFloat(c ? (c.saldo_cli || c.importe || 0) : 0)), 0);
          }
        }
      }
    } catch(e) {}
  }
  return parseFloat(poliza ? poliza.saldo_pendiente : 0) || 0;
}

function getCuotaEstadoBadge(item) {
  if (!item) return `<span class="badge" style="background:rgba(255,71,87,0.18); color:#ff4757; border:1px solid rgba(255,71,87,0.35); font-weight:700;">🔴 VENCIDA</span>`;
  const isPend = item.estado === 'PENDIENTE' || (parseFloat(item.saldo_cli || 0) > 0);
  if (!isPend) {
    return `<span class="badge" style="background:rgba(46,213,115,0.15); color:#2ed573; border:1px solid rgba(46,213,115,0.3); font-weight:700;">🟢 PAGADA</span>`;
  }

  if (!item.vto_cuota) {
    return `<span class="badge" style="background:rgba(255,71,87,0.18); color:#ff4757; border:1px solid rgba(255,71,87,0.35); font-weight:700;">🔴 VENCIDA</span>`;
  }

  const clean = String(item.vto_cuota).split('T')[0].split(' ')[0];
  const parts = clean.split('-');
  if (parts.length !== 3) {
    return `<span class="badge" style="background:rgba(255,71,87,0.18); color:#ff4757; border:1px solid rgba(255,71,87,0.35); font-weight:700;">🔴 VENCIDA</span>`;
  }

  const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);

  const diffDays = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return `<span class="badge" style="background:rgba(255,71,87,0.18); color:#ff4757; border:1px solid rgba(255,71,87,0.35); font-weight:700;">🔴 VENCIDA</span>`;
  } else if (diffDays <= 2) {
    return `<span class="badge" style="background:rgba(241,196,15,0.2); color:#f39c12; border:1px solid rgba(241,196,15,0.4); font-weight:700;">🟡 POR VENCER</span>`;
  } else {
    return `<span class="badge" style="background:rgba(0,180,216,0.15); color:#48cae4; border:1px solid rgba(0,180,216,0.3); font-weight:700;">🔵 FUTURA / A VENCER</span>`;
  }
}

async function fetchClientes() {
  const tableBody = getEl('clientsTableBody');
  if (tableBody) {
    tableBody.innerHTML = '<tr><td colspan="8" class="text-center"><div class="loading"></div></td></tr>';
  }

  try {
    const params = new URLSearchParams({
      page: state.pagination.page,
      limit: state.pagination.limit,
      sort_by: state.sort.by,
      sort_dir: state.sort.dir
    });

    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.tipo) params.set('tipo_seguro', state.filters.tipo);
    if (state.filters.estado) params.set('estado', state.filters.estado);
    if (state.filters.fecha_desde) params.set('fecha_desde', state.filters.fecha_desde);
    if (state.filters.fecha_hasta) params.set('fecha_hasta', state.filters.fecha_hasta);

    const res = await fetch(`/api/clientes?${params}`);
    const data = await res.json();

    state.clients = data.clientes || [];
    state.pagination.total = data.total || 0;
    state.pagination.pages = data.pages || 1;

    renderTable();
    renderPagination();
  } catch (err) {
    console.error('Error fetching clients:', err);
    if (tableBody) {
      tableBody.innerHTML = '<tr><td colspan="8" class="text-center" style="color:var(--danger);padding:2rem;">Error de conexión con el servidor. Reintentando...</td></tr>';
    }
  }
}

// ─── RENDERING ─────────────────────────────────────────────────────────────

function updateTableHeader() {
  const table = getEl('clientsTable');
  if (!table) return;
  const thead = table.querySelector('thead');
  if (!thead) return;

  const isCobranza = state.activeView === 'cobranza';

  const cols = getColumnPreferences();

  if (isCobranza) {
    thead.innerHTML = `
      <tr>
        ${cols.nombre ? `<th onclick="handleSort('nombre')" class="th-sortable">Cliente <span id="sort_icon_nombre" class="sort-icon">▲</span></th>` : ''}
        ${cols.telefono ? `<th onclick="handleSort('telefono')" class="th-sortable">Teléfono <span id="sort_icon_telefono" class="sort-icon">⇅</span></th>` : ''}
        ${cols.patente ? `<th onclick="handleSort('patente')" class="th-sortable">Patente <span id="sort_icon_patente" class="sort-icon">⇅</span></th>` : ''}
        ${cols.operacion ? `<th onclick="handleSort('operacion')" class="th-sortable">Póliza N° <span id="sort_icon_operacion" class="sort-icon">⇅</span></th>` : ''}
        ${cols.vehiculo ? `<th onclick="handleSort('vehiculo')" class="th-sortable">Vehículo <span id="sort_icon_vehiculo" class="sort-icon">⇅</span></th>` : ''}
        ${cols.nro_cuota ? `<th onclick="handleSort('nro_cuota')" class="th-sortable" title="Número de cuota impaga (NRE)">N° CUOTA <span id="sort_icon_nro_cuota" class="sort-icon">⇅</span></th>` : ''}
        ${cols.venc_cuota ? `<th onclick="handleSort('vencimiento')" class="th-sortable" title="Fecha exacta de vencimiento de la cuota impaga">VENC. CUOTA <span id="sort_icon_vencimiento" class="sort-icon">⇅</span></th>` : ''}
        ${cols.importe ? `<th onclick="handleSort('importe')" class="th-sortable" title="Saldo Cli pendiente de pago en NRE">IMPORTE PENDIENTE <span id="sort_icon_importe" class="sort-icon">⇅</span></th>` : ''}
        ${cols.dias_mora ? `<th onclick="handleSort('dias_mora')" class="th-sortable" title="Días transcurridos desde el vencimiento de la cuota (+ / -)">DÍAS DE MORA <span id="sort_icon_dias_mora" class="sort-icon">⇅</span></th>` : ''}
        ${cols.fin_vigencia ? `<th onclick="handleSort('fin_vigencia')" class="th-sortable" title="Fecha de fin de vigencia del contrato de póliza">FIN VIGENCIA PÓLIZA <span id="sort_icon_fin_vigencia" class="sort-icon">⇅</span></th>` : ''}
        ${cols.accion_cobranza ? `<th onclick="handleSort('prioridad_cobranza')" class="th-sortable">Acción Cobranza <span id="sort_icon_prioridad_cobranza" class="sort-icon">⇅</span></th>` : ''}
        ${cols.acciones ? `<th>Acciones</th>` : ''}
      </tr>
    `;
  } else {
    thead.innerHTML = `
      <tr>
        ${cols.nombre ? `<th onclick="handleSort('nombre')" class="th-sortable">Cliente <span id="sort_icon_nombre" class="sort-icon">▲</span></th>` : ''}
        ${cols.telefono ? `<th onclick="handleSort('telefono')" class="th-sortable">Teléfono <span id="sort_icon_telefono" class="sort-icon">⇅</span></th>` : ''}
        ${cols.patente ? `<th onclick="handleSort('patente')" class="th-sortable">Patente <span id="sort_icon_patente" class="sort-icon">⇅</span></th>` : ''}
        ${cols.operacion ? `<th onclick="handleSort('operacion')" class="th-sortable">Póliza N° <span id="sort_icon_operacion" class="sort-icon">⇅</span></th>` : ''}
        ${cols.vehiculo ? `<th onclick="handleSort('vehiculo')" class="th-sortable">Vehículo <span id="sort_icon_vehiculo" class="sort-icon">⇅</span></th>` : ''}
        ${cols.venc_cuota ? `<th onclick="handleSort('vencimiento')" class="th-sortable">Vencimiento <span id="sort_icon_vencimiento" class="sort-icon">⇅</span></th>` : ''}
        ${cols.estado_poliza ? `<th onclick="handleSort('estado')" class="th-sortable">Estado Póliza <span id="sort_icon_estado" class="sort-icon">⇅</span></th>` : ''}
        ${cols.accion_poliza ? `<th onclick="handleSort('prioridad_poliza')" class="th-sortable">Acción Póliza <span id="sort_icon_prioridad_poliza" class="sort-icon">⇅</span></th>` : ''}
        ${cols.acciones ? `<th>Acciones</th>` : ''}
      </tr>
    `;
  }
}

function getRenovacionesRank(item) {
  const p = item.poliza;
  if (!p) return 4;

  const fvRen = p.fin_vigencia_poliza || p.fecha_vencimiento;
  if (!fvRen) return 4;

  const clean = String(fvRen).split('T')[0].split(' ')[0];
  const parts = clean.split('-');
  let isVencida = false;
  if (parts.length === 3) {
    const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    isVencida = vtoDate < todayDate;
  }

  const saldo = parseFloat(p.saldo_pendiente || 0);
  const cuotas = parseInt(p.cuotas_debe || 0);
  const tieneDeuda = saldo > 0 || cuotas > 0;

  // 1. 🟢 PRIMERO (Rank 1): Clientes AL DÍA (Saldo = 0 / Sin cuotas impagas) que no están vencidas.
  if (!isVencida && !tieneDeuda) {
    return 1;
  }

  // 2. 🟠 SEGUNDO (Rank 2): Clientes CON DEUDA (Saldo > 0 / Con cuotas impagas) que no están vencidas.
  if (!isVencida && tieneDeuda) {
    return 2;
  }

  // 3. ⚫ TERCERO (Rank 3): Pólizas ya vencidas.
  if (isVencida) {
    return 3;
  }

  return 4;
}

function renderTable() {
  const tableBody = getEl('clientsTableBody');
  const emptyState = getEl('emptyState');
  if (!tableBody) return;

  updateTableHeader();
  tableBody.innerHTML = '';

  if (!state.clients || state.clients.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    const emptyMsg = (state.filters.estado === 'poliza_vencida' || state.filters.estado === 'vencida')
      ? 'No se encontraron pólizas vencidas'
      : 'No se encontraron clientes para los filtros seleccionados';
    tableBody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding:40px; color:#a0a0b8;"><div style="font-size:2rem; margin-bottom:10px;">🔍</div><strong style="color:var(--text-primary); font-size:1.05rem;">${emptyMsg}</strong></td></tr>`;
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  const items = [];
  state.clients.forEach(client => {
    const polizas = client.polizas || [];
    if (polizas.length === 0) {
      items.push({ client, poliza: null, isSecondary: false });
    } else {
      polizas.forEach((poliza, idx) => {
        items.push({ client, poliza, isSecondary: idx > 0 });
      });
    }
  });

  if (state.activeView === 'renovaciones') {
    items.sort((a, b) => {
      const rankA = getRenovacionesRank(a);
      const rankB = getRenovacionesRank(b);
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      const dateA = a.poliza ? (a.poliza.fin_vigencia_poliza || a.poliza.fecha_vencimiento || '') : '';
      const dateB = b.poliza ? (b.poliza.fin_vigencia_poliza || b.poliza.fecha_vencimiento || '') : '';
      return dateA.localeCompare(dateB);
    });
  }

  items.forEach(item => {
    const row = createClientRow(item.client, item.poliza, item.isSecondary);
    tableBody.appendChild(row);
  });

  makeColumnsResizable();
}

function createClientRow(client, poliza, isSecondary = false) {
  const row = document.createElement('tr');
  row.className = 'client-row';
  if (isSecondary) row.style.opacity = '0.85';

  const isCobranza = state.activeView === 'cobranza';
  const isRenovaciones = state.activeView === 'renovaciones';

  const targetDateRen = poliza ? (poliza.fin_vigencia_poliza || poliza.fecha_vencimiento) : null;
  const estado = poliza 
    ? (isRenovaciones ? calculateEstado(targetDateRen) : calculateEstado(poliza.fecha_vencimiento)) 
    : { text: '-', class: '' };
  const fechaStr = poliza 
    ? (isRenovaciones ? formatDate(targetDateRen) : formatDate(poliza.fecha_vencimiento)) 
    : '-';

  const formattedName = formatClientName(client.nombre || '-');
  const nameHtml = isSecondary 
    ? `<span style="color: var(--accent-cyan-light); font-size: 0.88rem;" title="Mismo cliente (Segunda póliza)">↳ <strong>${escapeHtml(formattedName)}</strong></span>` 
    : `<strong>${escapeHtml(formattedName)}</strong>`;

  const phoneHtml = client.telefono 
    ? `<span>📱 ${escapeHtml(client.telefono)}</span>` 
    : `<span class="text-muted">📵 Sin teléfono</span>`;

  const resCobranza = poliza ? calcularAccionCobranza(poliza) : { accion: '🟢 Al día', tagClass: 'tag-green' };
  const resPoliza = poliza ? calcularAccionPoliza(poliza) : { accion: '🟢 Contrato vigente', tagClass: 'tag-green' };

  const actionCobranzaTagHtml = `<span class="action-tag ${resCobranza.tagClass}">${escapeHtml(resCobranza.accion)}</span>`;
  const actionPolizaTagHtml = `<span class="action-tag ${resPoliza.tagClass}">${escapeHtml(resPoliza.accion)}</span>`;

  const cols = getColumnPreferences();
  let cells = '';

  if (cols.nombre) cells += `<td>${nameHtml}</td>`;
  if (cols.telefono) cells += `<td>${phoneHtml}</td>`;
  if (cols.patente) cells += `<td><strong>${poliza ? escapeHtml(poliza.patente || '-') : '-'}</strong></td>`;
  if (cols.operacion) cells += `<td><span style="font-size:0.83rem; font-weight:700; color:var(--accent-cyan-light); font-family:monospace; background:rgba(0,180,216,0.12); padding:3px 8px; border-radius:6px; border:1px solid rgba(0,180,216,0.25);">${poliza ? escapeHtml(poliza.operacion || '-') : '-'}</span></td>`;
  if (cols.vehiculo) cells += `<td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${poliza ? escapeHtml(poliza.vehiculo || '') : ''}">${poliza ? escapeHtml(poliza.vehiculo || '-') : '-'}</td>`;

  if (isCobranza) {
    const nroCuota = poliza ? (poliza.nro_cuota || 1) : 1;
    const totalCuotas = poliza ? (poliza.total_cuotas || 3) : 3;
    const cuotaStr = `Cuota ${nroCuota}/${totalCuotas}`;

    const saldoVal = getSaldoExigible(poliza);
    const saldoStr = saldoVal > 0 
      ? `$ ${saldoVal.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : '$ 0,00';

    let diasMoraHtml = '-';
    if (poliza && poliza.fecha_vencimiento && typeof SeguroStateManager !== 'undefined') {
      const clean = String(poliza.fecha_vencimiento).split('T')[0].split(' ')[0];
      const parts = clean.split('-');
      if (parts.length === 3) {
        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);
        const diffDays = Math.round((todayDate - vtoDate) / (1000 * 60 * 60 * 24));
        if (diffDays > 0) {
          diasMoraHtml = `<span class="badge" style="background:rgba(255,71,87,0.18); color:#ff4757; border:1px solid rgba(255,71,87,0.35);">+${diffDays} días</span>`;
        } else if (diffDays === 0) {
          diasMoraHtml = `<span class="badge" style="background:rgba(241,196,15,0.2); color:#f39c12; border:1px solid rgba(241,196,15,0.4);">Vence hoy</span>`;
        } else {
          diasMoraHtml = `<span class="badge" style="background:rgba(46,213,115,0.15); color:#2ed573; border:1px solid rgba(46,213,115,0.3);">${diffDays} días</span>`;
        }
      }
    }

    const finVigStr = poliza && poliza.fin_vigencia_poliza 
      ? formatDate(poliza.fin_vigencia_poliza) 
      : (poliza && poliza.fecha_vencimiento ? formatDate(poliza.fecha_vencimiento) : '-');

    if (cols.nro_cuota) cells += `<td><span class="badge" style="background:rgba(0,180,216,0.12); color:#48cae4; border:1px solid rgba(0,180,216,0.25); font-weight:700;">${cuotaStr}</span></td>`;
    if (cols.venc_cuota) cells += `<td><strong>${fechaStr}</strong></td>`;
    if (cols.importe) cells += `<td><strong style="color:${saldoVal > 0 ? '#ff4757' : '#2ed573'};">${saldoStr}</strong></td>`;
    if (cols.dias_mora) cells += `<td>${diasMoraHtml}</td>`;
    if (cols.fin_vigencia) cells += `<td><span style="color:var(--text-secondary); font-size:0.83rem; font-family:monospace;">${finVigStr}</span></td>`;
    if (cols.accion_cobranza) cells += `<td>${actionCobranzaTagHtml}</td>`;
  } else {
    if (cols.venc_cuota) cells += `<td>${fechaStr}</td>`;
    if (cols.estado_poliza) cells += `<td>${estado.class ? `<span class="badge badge-${estado.class}">${estado.text}</span>` : '-'}</td>`;
    if (cols.accion_poliza) cells += `<td>${actionPolizaTagHtml}</td>`;
  }

  if (cols.acciones) {
    const actionsHtml = `
      <div class="row-actions">
        ${poliza ? `
          <button type="button" class="btn btn-sm btn-ghost" onclick="showCuotasModal(${poliza.id}, '${escapeQuotes(poliza.operacion || '')}')" title="Ver Historial de Cuotas y Lote NRE" style="color: #48cae4; font-weight: 700; gap: 4px; padding: 4px 8px; border: 1px solid rgba(0, 180, 216, 0.3);">
            🧾 Cuotas
          </button>
        ` : ''}
        ${(client.telefono && client.telefono.length >= 10) ? `
          ${(() => {
            const isWaSent = localStorage.getItem('segucar_wa_sent_' + client.id + '_' + (poliza ? poliza.operacion : '')) === 'true';
            const btnClass = isWaSent ? 'btn-whatsapp-sent' : 'btn-whatsapp';
            const btnLabel = isWaSent ? 'Enviado ✅' : 'Enviar';
            return `
              <button type="button" class="btn btn-sm ${btnClass} btn-smart-wa" data-cli="${client.id}" data-pol="${poliza ? poliza.operacion : ''}" style="padding: 6px 14px; font-weight: 700; font-size: 0.78rem; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; margin: 0; box-shadow: 0 4px 12px rgba(37,211,102,0.3);" onclick="triggerSmartWhatsApp(${client.id}, '${poliza ? poliza.operacion : ''}')" title="Enviar WhatsApp a ${escapeQuotes(formattedName)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                <span>${btnLabel}</span>
              </button>
            `;
          })()}
        ` : `
          <button type="button" class="btn btn-sm" disabled style="padding: 6px 14px; font-weight: 700; font-size: 0.8rem; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.35); border: 1px solid rgba(255,255,255,0.1); cursor: not-allowed; opacity: 0.6;" title="${client.telefono ? `Teléfono incompleto / inválido (${client.telefono})` : 'Sin teléfono para enviar WhatsApp'}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="rgba(255,255,255,0.3)"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            <span>${client.telefono ? 'Inválido' : 'Sin Teléfono'}</span>
          </button>
        `}
        <button class="btn btn-sm btn-ghost" onclick="editClient(${client.id})" title="Editar">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="deleteClient(${client.id})" title="Eliminar">🗑️</button>
      </div>
    </td>
    `;
    cells += actionsHtml;
  }

  row.innerHTML = cells;
  return row;
}

function getTipoBadge(tipo) {
  if (tipo === 'Moto') return '🏍️ Moto';
  if (tipo === 'Pick Up') return '🛻 Pick Up';
  if (tipo === 'Camión') return '🚛 Camión';
  return '🚗 Auto';
}

function renderPagination() {
  const container = getEl('paginationControls');
  if (!container) return;
  const { page, pages } = state.pagination;

  if (pages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <button class="btn btn-sm btn-ghost" ${page === 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">← Ant</button>
    <span style="font-size:0.9rem; font-weight:600;">Página ${page} de ${pages}</span>
    <button class="btn btn-sm btn-ghost" ${page === pages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Sig →</button>
  `;
  container.innerHTML = html;
}

function goToPage(p) {
  if (p < 1 || p > state.pagination.pages) return;
  state.pagination.page = p;
  fetchClientes();
}

function calcularAccionCobranza(polizaInput) {
  if (typeof SeguroStateManager !== 'undefined') {
    const res = SeguroStateManager.evaluarCobranza(polizaInput, state.lastSyncDate);
    return { accion: res.accion, tagClass: res.tagClass };
  }
  return { accion: '🟢 Al día', tagClass: 'tag-green' };
}

function calcularAccionPoliza(polizaInput) {
  if (typeof SeguroStateManager !== 'undefined') {
    const res = SeguroStateManager.evaluarRenovacion(polizaInput);
    return { accion: res.accion, tagClass: res.tagClass };
  }
  return { accion: '🟢 Contrato vigente', tagClass: 'tag-green' };
}

function getAccionPorVista(polizaInput, viewName) {
  if (!polizaInput) return { accion: 'Sin acción', prioridad: 'baja', tagClass: 'tag-green', plantilla: 'recordatorio_48hs' };
  
  const currentView = viewName || state.activeView;

  if (currentView === 'renovaciones') {
    if (typeof SeguroStateManager !== 'undefined') {
      const resRen = SeguroStateManager.evaluarRenovacion(polizaInput);
      const templateMap = {
        'RENOVACION_DEUDA': 'renovacion_deuda',
        'RENOVACION_7_DIAS': 'renovacion_7_dias',
        'VENCE_PRONTO': 'renovacion_7_dias',
        'POLIZA_VENCIDA': 'poliza_vencida'
      };
      return {
        codigo: resRen.code,
        accion: resRen.accionDetalle || resRen.accion,
        prioridad: resRen.prioridadLevel,
        rank: resRen.prioridadRank,
        badgeColor: resRen.badgeColor,
        plantilla: resRen.plantilla || templateMap[resRen.code] || 'renovacion_7_dias'
      };
    }
    const saldo = parseFloat(polizaInput ? (polizaInput.saldo_pendiente || 0) : 0);
    const cuotas = parseInt(polizaInput ? (polizaInput.cuotas_debe || 0) : 0);
    const plantillaType = (saldo > 0 || cuotas > 0) ? 'renovacion_deuda' : 'renovacion_7_dias';
    return { accion: 'Renovación Póliza', prioridad: 'alta', tagClass: 'tag-blue', plantilla: plantillaType };
  } else if (currentView === 'cobranza') {
    if (typeof SeguroStateManager !== 'undefined') {
      const resCob = SeguroStateManager.evaluarCobranza(polizaInput, state.lastSyncDate);
      const templateMap = {
        'RECORDATORIO_48HS': 'recordatorio_48hs',
        'CUOTA_VENCIDA_0_48HS': 'primer_aviso',
        'CUOTA_VENCIDA_48_96HS': 'segundo_aviso',
        'MORA_CRITICA_96HS': 'mora_critica'
      };
      return {
        codigo: resCob.code,
        accion: resCob.accionDetalle,
        prioridad: resCob.prioridadLevel,
        rank: resCob.prioridadRank,
        badgeColor: resCob.badgeColor,
        plantilla: templateMap[resCob.code] || 'primer_aviso'
      };
    }
    let fallbackPlantilla = 'primer_aviso';
    if (polizaInput && polizaInput.fecha_vencimiento) {
      const parts = polizaInput.fecha_vencimiento.split('-');
      if (parts.length === 3) {
        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
        if (vtoDate >= todayDate) fallbackPlantilla = 'recordatorio_48hs';
      }
    }
    return { accion: 'Cobranza Cuota', prioridad: 'alta', tagClass: 'tag-amber', plantilla: fallbackPlantilla };
  } else {
    if (typeof SeguroStateManager !== 'undefined') {
      return SeguroStateManager.evaluarProximaAccion(polizaInput, state.lastSyncDate);
    }
    return { accion: 'Sin acción', prioridad: 'baja', tagClass: 'tag-green', plantilla: 'recordatorio_48hs' };
  }
}

function calcularProximaAccion(polizaInput) {
  return getAccionPorVista(polizaInput, state.activeView);
}

// ─── WHATSAPP ──────────────────────────────────────────────────────────────

function getTemplateMatchScore(t, recTarget, activeView) {
  if (!t) return 0;
  const tType = String(t.tipo || '').toLowerCase();
  const tName = String(t.nombre || t.name || '').toLowerCase();
  const target = String(recTarget || '').toLowerCase();

  // Exact match gets highest score
  if (tType === target) return 100;

  // Specific target matching
  if (target === 'renovacion_deuda') {
    if (tType === 'renovacion_deuda' || (tName.includes('deuda') && tName.includes('renovación')) || tName.includes('renovación + deuda') || tName.includes('renovacion + deuda')) return 90;
  } else if (target === 'renovacion_7_dias') {
    if (tType === 'renovacion_7_dias' || (tName.includes('aviso renovación') && !tName.includes('deuda'))) return 90;
  } else if (target === 'poliza_vencida') {
    if (tType === 'poliza_vencida' || tName.includes('póliza vencida') || tName.includes('poliza vencida')) return 90;
  } else if (target === 'recordatorio_48hs') {
    if (tType === 'recordatorio_48hs' || tName.includes('recordatorio preventivo')) return 90;
  } else if (target === 'primer_aviso') {
    if (tType === 'primer_aviso' || tName.includes('primer aviso')) return 90;
  } else if (target === 'segundo_aviso') {
    if (tType === 'segundo_aviso' || tName.includes('segundo aviso')) return 90;
  } else if (target === 'mora_critica') {
    if (tType === 'mora_critica' || tName.includes('mora crítica') || tName.includes('mora critica')) return 90;
  }

  // Same module fallback matching
  if (activeView === 'renovaciones' && (tType.includes('renovacion') || tName.includes('renovación') || tName.includes('póliza'))) return 40;
  if (activeView === 'cobranza' && (tType.includes('cuota') || tType.includes('aviso') || tType.includes('mora') || tName.includes('cuota'))) return 40;

  return 0;
}

function isTemplateMatch(t, recTarget, activeView) {
  return getTemplateMatchScore(t, recTarget, activeView) > 0;
}

function showWaPopover(e, clientId, operacion, vehiculo, fechaVenc, patente) {
  e.stopPropagation();
  const btn = e.currentTarget || (e.target ? e.target.closest('button') : null);
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const popover = getEl('globalWaPopover');
  if (!popover) return;

  if (popover.classList.contains('active') && popover.dataset.activeClient == clientId) {
    popover.classList.remove('active');
    popover.dataset.activeClient = '';
    return;
  }

  popover.dataset.activeClient = clientId;

  const client = state.clients.find(c => c.id === clientId);
  if (!client) return;

  const templates = state.templates && state.templates.length > 0 ? state.templates : [
    { id: 1, name: 'Aviso de vencimiento' },
    { id: 2, name: 'Recordatorio de renovación' },
    { id: 3, name: 'Aviso de cobranza (Cuotas pendientes)' },
    { id: 4, name: 'Recuperación de cliente (Reactivación)' }
  ];

  const poliza = client.polizas ? client.polizas.find(p => p.operacion === operacion) : (client.polizas ? client.polizas[0] : null);
  const recAccion = poliza ? getAccionPorVista(poliza, state.activeView) : null;

  let sortedTemplates = [...templates];
  if (recAccion && recAccion.plantilla) {
    const recTarget = recAccion.plantilla.toLowerCase();
    sortedTemplates.sort((a, b) => {
      const scoreA = getTemplateMatchScore(a, recTarget, state.activeView);
      const scoreB = getTemplateMatchScore(b, recTarget, state.activeView);
      return scoreB - scoreA;
    });
  }

  let html = `
    <div style="padding: 10px 16px; font-size: 0.72rem; text-transform: uppercase; color: var(--accent-cyan-light); font-weight: 700; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 4px; letter-spacing: 0.5px;">
      📱 Elegir Plantilla WhatsApp
    </div>
  `;

  html += sortedTemplates.map((t, idx) => {
    const tName = t.nombre || t.name;
    const isRec = idx === 0 && recAccion && recAccion.plantilla;
    return `
      <div class="wa-template-item" onclick="sendWhatsApp(${clientId}, ${t.id}, '${operacion}', '${escapeQuotes(vehiculo)}', '${fechaVenc}', '${escapeQuotes(patente)}')">
        <div>
          ${isRec ? `<span style="background: rgba(241,196,15,0.25); color: #f1c40f; font-size: 0.68rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; display: inline-block; margin-bottom: 2px;">⭐ RECOMENDADA AUTO</span><br>` : ''}
          ${escapeHtml(tName)}
        </div>
      </div>
    `;
  }).join('');

  html += `
    <div style="padding: 8px 12px; border-top: 1px solid rgba(255,255,255,0.08); margin-top: 4px;">
      <button type="button" class="btn btn-sm btn-ghost w-100" onclick="reportInvalidPhone(${clientId})" style="color:#ff4757; border:1px solid rgba(255,71,87,0.4); background:rgba(255,71,87,0.1); font-weight:700; width:100%; justify-content:center; gap:6px; padding:6px 10px;">
        🚫 Número no existe / Sin WhatsApp
      </button>
    </div>
  `;

  popover.innerHTML = html;
  popover.classList.add('active');

  const popoverHeight = popover.offsetHeight || 280;
  const popoverWidth = popover.offsetWidth || 320;

  let top = rect.bottom + 6;
  if (top + popoverHeight > window.innerHeight - 10) {
    top = Math.max(10, rect.top - popoverHeight - 6);
  }

  let left = rect.right - popoverWidth;
  if (left < 10) left = 10;
  if (left + popoverWidth > window.innerWidth - 10) {
    left = window.innerWidth - popoverWidth - 10;
  }

  popover.style.position = 'fixed';
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
  popover.style.zIndex = '999999';
}

document.addEventListener('click', (e) => {
  const popover = getEl('globalWaPopover');
  if (popover && !e.target.closest('#globalWaPopover') && !e.target.closest('.btn-whatsapp')) {
    popover.classList.remove('active');
    popover.dataset.activeClient = '';
  }
});

function getWaMessageData(client, polizaInput, template) {
  const polizas = client.polizas || [];
  const withDebt = polizas.filter(p => parseFloat(p.saldo_pendiente || 0) > 0);
  
  const isRenovaciones = state.activeView === 'renovaciones';
  let targetPolizas = [];
  
  if (isRenovaciones) {
    targetPolizas = polizas.filter(p => {
      const fvRen = p.fin_vigencia_poliza || p.fecha_vencimiento;
      if (!fvRen) return false;
      const parts = fvRen.split('-');
      if (parts.length !== 3) return false;
      const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      const todayDate = new Date();
      todayDate.setHours(0, 0, 0, 0);
      const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
      return calDiffRen <= 7;
    });
  } else {
    targetPolizas = withDebt;
  }
  
  if (targetPolizas.length === 0) {
    targetPolizas = polizas.length > 0 ? [polizas[0]] : [];
  }
  
  let vehiculo = '';
  let patente = '';
  let operacion = '';
  let fechaVenc = '';
  let cuotasDebe = '1';
  let totalSaldo = 0;
  
  if (targetPolizas.length === 1) {
    const p = targetPolizas[0];
    vehiculo = p.vehiculo || p.tipo_vehiculo || '';
    patente = p.patente || '';
    operacion = p.operacion || '';
    const fechaParaMensaje = isRenovaciones ? (p.fin_vigencia_poliza || p.fecha_vencimiento) : p.fecha_vencimiento;
    fechaVenc = fechaParaMensaje ? formatDate(fechaParaMensaje) : '';
    cuotasDebe = String(p.cuotas_debe || 1);
    totalSaldo = parseFloat(p.saldo_pendiente || 0);
  } else if (targetPolizas.length > 1) {
    const listLines = targetPolizas.map(p => `• ${p.vehiculo || p.tipo_vehiculo || 'Vehículo'} (Patente ${p.patente || '-'})`).join('\n');
    vehiculo = '\n' + listLines;
    patente = targetPolizas.map(p => p.patente || '').filter(Boolean).join(', ');
    operacion = targetPolizas.map(p => p.operacion || '').filter(Boolean).join(', ');
    fechaVenc = targetPolizas.map(p => {
      const f = isRenovaciones ? (p.fin_vigencia_poliza || p.fecha_vencimiento) : p.fecha_vencimiento;
      return f ? formatDate(f) : '';
    }).filter(Boolean).join(', ');
    cuotasDebe = String(targetPolizas.reduce((sum, p) => sum + (parseInt(p.cuotas_debe) || 0), 0));
    totalSaldo = targetPolizas.reduce((sum, p) => sum + (parseFloat(p.saldo_pendiente) || 0), 0);
  }
  
  const saldoStr = totalSaldo > 0 
    ? `$ ${totalSaldo.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
    : '$ 0,00';
    
  const formattedName = formatClientName(client.nombre);
  let msgTemplate = template.mensaje || template.template || '';

  // Si tiene múltiples vehículos, limpiar la plantilla para que la lista itemizada no quede torpe
  if (targetPolizas.length > 1) {
    if (msgTemplate.includes(' ({vehiculo} - Patente {patente})')) {
      msgTemplate = msgTemplate.replace(' ({vehiculo} - Patente {patente})', ':\n' + vehiculo);
    } else if (msgTemplate.includes('({vehiculo} - Patente {patente})')) {
      msgTemplate = msgTemplate.replace('({vehiculo} - Patente {patente})', ':\n' + vehiculo);
    } else if (msgTemplate.includes(' {vehiculo} (Patente {patente})')) {
      msgTemplate = msgTemplate.replace(' {vehiculo} (Patente {patente})', ':\n' + vehiculo);
    } else if (msgTemplate.includes('{vehiculo} (Patente {patente})')) {
      msgTemplate = msgTemplate.replace('{vehiculo} (Patente {patente})', ':\n' + vehiculo);
    }
  }

  const msg = msgTemplate
    .replace(/Hola \{nombre\},/gi, 'Hola,')
    .replace(/Hola \{nombre\}/gi, 'Hola')
    .replace(/\{nombre\},/gi, '')
    .replace(/\{nombre\}/gi, '')
    .replace(/tu \{vehiculo\} \(Patente \{patente\}\)/g, `tu póliza N° ${operacion} (Patente ${patente})`)
    .replace(/tu seguro \(\{vehiculo\} - Patente \{patente\}\)/g, `tu póliza N° ${operacion} (Patente ${patente})`)
    .replace(/\{vehiculo\}/g, `póliza N° ${operacion}`)
    .replace(/\{patente\}/g, patente)
    .replace(/\{fecha_vencimiento\}/g, fechaVenc)
    .replace(/\{operacion\}/g, operacion)
    .replace(/\{tipo_seguro\}/g, `póliza N° ${operacion}`)
    .replace(/\{cuotas_debe\}/g, cuotasDebe)
    .replace(/\{importe\}/g, saldoStr)
    .replace(/\{monto\}/g, saldoStr)
    .replace(/\{saldo_pendiente\}/g, saldoStr);

  return { msg, poliza: targetPolizas[0] };
}

function triggerSmartWhatsApp(clientId, operacion) {
  const client = state.clients.find(c => c.id === clientId);
  if (!client) return;

  if (!client.telefono) {
    showToast('Este cliente no tiene teléfono cargado', 'error');
    return;
  }

  let poliza = client.polizas ? client.polizas.find(p => p.operacion === operacion) : null;
  if (!poliza && client.polizas && client.polizas.length > 0) {
    const withDebt = client.polizas.filter(p => parseFloat(p.saldo_pendiente || 0) > 0);
    poliza = withDebt.length > 0 ? withDebt[0] : client.polizas[0];
  }

  if (!poliza) {
    showToast('El cliente no tiene pólizas registradas', 'error');
    return;
  }

  const recAccion = getAccionPorVista(poliza, state.activeView);
  const templateType = (recAccion && recAccion.plantilla) 
    ? recAccion.plantilla 
    : (state.activeView === 'renovaciones' ? 'renovacion_7_dias' : 'primer_aviso');
  
  const sortedTemplates = (state.templates || []).slice().sort((a, b) => {
    const scoreA = getTemplateMatchScore(a, templateType, state.activeView);
    const scoreB = getTemplateMatchScore(b, templateType, state.activeView);
    return scoreB - scoreA;
  });

  let template = sortedTemplates.length > 0 && getTemplateMatchScore(sortedTemplates[0], templateType, state.activeView) > 0
    ? sortedTemplates[0]
    : null;

  if (!template && state.templates && state.templates.length > 0) {
    template = state.templates[0];
  }

  if (!template) {
    showToast('No se encontraron plantillas de mensaje configuradas', 'error');
    return;
  }

  const { msg, poliza: resolvedPoliza } = getWaMessageData(client, poliza, template);

  const phone = formatPhoneForWhatsApp(client.telefono);
  if (!phone) {
    showToast('Número de teléfono inválido', 'error');
    return;
  }

  const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
  markWhatsAppAsSent(clientId, operacion);
  showToast('Abriendo WhatsApp (Envío Inteligente)...', 'success');

  fetch('/api/contactos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cliente_id: clientId,
      poliza_id: resolvedPoliza ? resolvedPoliza.id : null,
      tipo: template.tipo,
      medio: 'whatsapp',
      mensaje: msg
    })
  }).catch(err => console.error('Error logging contact:', err));
}

async function reportInvalidPhone(clientId) {
  const popover = getEl('globalWaPopover');
  if (popover) popover.classList.remove('active');

  const client = state.clients ? state.clients.find(c => c.id === clientId) : null;
  const clientName = client ? client.nombre : 'este cliente';

  if (!confirm(`¿Confirmás que el teléfono de ${clientName} no existe o no tiene WhatsApp?\n\nEl número será eliminado y el cliente pasará a la lista "Sin Celular / Requiere Actualización".`)) {
    return;
  }

  try {
    const res = await fetch(`/api/clientes/${clientId}/reportar-telefono-invalido`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'numero_inexistente' })
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Teléfono marcado como inválido. Pasado a Sin Celular', 'info');
      fetchClientes();
      fetchStats();
    } else {
      showToast(data.error || 'Error al reportar teléfono', 'error');
    }
  } catch (err) {
    console.error('Error reportando teléfono inválido:', err);
    showToast('Error de conexión al reportar teléfono', 'error');
  }
}

function markWhatsAppAsSent(clientId, operacion) {
  const key = 'segucar_wa_sent_' + clientId + '_' + (operacion || '');
  localStorage.setItem(key, 'true');

  const btns = document.querySelectorAll(`.btn-smart-wa[data-cli="${clientId}"][data-pol="${operacion || ''}"]`);
  btns.forEach(btn => {
    btn.classList.remove('btn-whatsapp');
    btn.classList.add('btn-whatsapp-sent');
    const span = btn.querySelector('span');
    if (span) span.textContent = 'Enviado ✅';
  });
}

function sendWhatsApp(clientId, templateId, operacion, vehiculo, fechaVenc, patente) {
  const client = state.clients.find(c => c.id === clientId);
  const template = state.templates.find(t => t.id === templateId);

  if (!client || !template) return;

  if (!client.telefono) {
    showToast('Este cliente no tiene teléfono cargado', 'error');
    return;
  }

  const poliza = client.polizas ? client.polizas.find(p => p.operacion === operacion) : null;
  const { msg, poliza: resolvedPoliza } = getWaMessageData(client, poliza, template);

  const phone = formatPhoneForWhatsApp(client.telefono);
  if (!phone) {
    showToast('Número de teléfono inválido', 'error');
    return;
  }

  const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
  markWhatsAppAsSent(clientId, operacion);
  showToast('Abriendo WhatsApp...', 'success');

  fetch('/api/contactos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cliente_id: clientId,
      poliza_id: resolvedPoliza ? resolvedPoliza.id : null,
      tipo: template.tipo,
      medio: 'whatsapp',
      mensaje: msg
    })
  }).catch(err => console.error('Error logging contact:', err));

  const popover = getEl('globalWaPopover');
  if (popover) popover.classList.remove('active');
}

function formatPhoneForWhatsApp(phone) {
  if (!phone) return '';
  let str = String(phone).replace(/[^\d]/g, '');
  if (!str) return '';

  // 1. Quitar prefijo internacional +549 / 549 / 54 si existe
  if (str.startsWith('549')) {
    str = str.substring(3);
  } else if (str.startsWith('54')) {
    str = str.substring(2);
  }

  // 2. Eliminar '0' inicial de característica (ej: 0223 -> 223) o ceros a la izquierda
  while (str.startsWith('0')) {
    str = str.substring(1);
  }

  // 3. Eliminar '15' móvil (ej: 223156002079 -> 2236002079)
  if (str.startsWith('22315') && str.length >= 11) {
    str = '223' + str.substring(5);
  } else if (str.startsWith('15') && str.length === 9) {
    str = str.substring(2);
  }

  // 4. Si tiene 11 dígitos y empieza con 2230... (0 duplicado en área), remover el 0 extra
  if (str.startsWith('2230') && str.length === 11) {
    str = '223' + str.substring(4);
  }

  // Si tiene 7 u 8 dígitos locales, anteponer 223
  if (str.length === 7 || str.length === 8) {
    str = '223' + str;
  }

  // 5. Validar que la cadena resultante tenga EXACTAMENTE 10 dígitos
  if (str.length === 10) {
    return '549' + str;
  }

  return '';
}

function calculateEstado(dateStr) {
  if (!dateStr) return { text: '-', class: '' };
  
  const clean = String(dateStr).split('T')[0].split(' ')[0];
  const parts = clean.split('-');
  if (parts.length !== 3) return { text: '-', class: '' };

  const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));

  // Estado Póliza: refleja EXACTAMENTE las reglas del servidor y stateManager
  if (diffDays < 0)  return { text: '⚫ Póliza Vencida',              class: 'vencida'    };
  if (diffDays === 7) return { text: '📄 Aviso Renovación (7 Días)',  class: 'por-vencer'  };
  
  return { text: '🟢 Contrato Vigente', class: 'vigente' };
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const clean = String(dateStr).split('T')[0].split(' ')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    const rawFormatted = `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
    
    const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));

    let relativeLabel = '';
    if (diffDays === 0) relativeLabel = 'Hoy';
    else if (diffDays === 1) relativeLabel = 'Mañana';
    else if (diffDays === -1) relativeLabel = 'Ayer';
    else if (diffDays > 1 && diffDays <= 7) relativeLabel = `En ${diffDays} días`;
    else if (diffDays < -1) relativeLabel = `Hace ${Math.abs(diffDays)} días`;

    if (relativeLabel) {
      return `<strong style="color:var(--accent-cyan-light); font-size:0.84rem;">${relativeLabel}</strong> <span style="font-size:0.75rem; color:var(--text-secondary);">(${rawFormatted})</span>`;
    }
    return rawFormatted;
  }
  return dateStr;
}

// ─── CRUD ACTIONS ─────────────────────────────────────────────────────────

function openModal(client = null) {
  const modal = getEl('clientModal');
  if (!modal) return;
  modal.classList.add('active');

  const titleEl = getEl('modalTitle');
  const idEl = getEl('clientId');

  if (client) {
    if (titleEl) titleEl.textContent = 'Editar Cliente';
    if (idEl) idEl.value = client.id;
    getEl('clientName').value = client.nombre || '';
    getEl('clientDNI').value = client.dni || '';
    getEl('clientPhone').value = client.telefono || '';
    getEl('clientAddress').value = client.direccion || '';
    getEl('clientEmail').value = client.email || '';
  } else {
    if (titleEl) titleEl.textContent = 'Agregar Cliente';
    const form = getEl('clientForm');
    if (form) form.reset();
    if (idEl) idEl.value = '';
  }
}

function closeModal() {
  const modal = getEl('clientModal');
  if (modal) modal.classList.remove('active');
}

async function handleClientSubmit(e) {
  e.preventDefault();

  const id = getEl('clientId')?.value;
  const body = {
    nombre: getEl('clientName')?.value || '',
    dni: getEl('clientDNI')?.value || '',
    telefono: getEl('clientPhone')?.value || '',
    direccion: getEl('clientAddress')?.value || '',
    email: getEl('clientEmail')?.value || ''
  };

  try {
    const url = id ? `/api/clientes/${id}` : '/api/clientes';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    closeModal();
    showToast(id ? 'Cliente actualizado' : 'Cliente creado', 'success');
    fetchStats();
    fetchClientes();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function editClient(id) {
  const client = state.clients.find(c => c.id === id);
  if (client) openModal(client);
}

async function deleteClient(id) {
  if (!confirm('¿Estás seguro de eliminar este cliente y todas sus pólizas?')) return;

  try {
    const res = await fetch(`/api/clientes/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast('Cliente eliminado', 'success');
    fetchStats();
    fetchClientes();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ─── UTILS ─────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = getEl('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s ease-out reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeQuotes(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'");
}

function formatClientName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function triggerSyncNRE() {
  const btn = document.getElementById('btnSyncNRE');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Sincronizando...';
  }

  showToast('Conectando en vivo con portal NRE para sincronizar emisiones y pagos...', 'info');

  try {
    const res = await fetch('/api/sync-nre', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast('¡Sincronización en vivo completada con éxito!', 'success');
      await fetchStats();
      await fetchClientes(state.pagination.page);
    } else {
      showToast(data.error || 'Error al sincronizar con NRE', 'error');
    }
  } catch (e) {
    showToast('Error de conexión al sincronizar con NRE', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🔄 Sincronizar NRE';
    }
  }
}

function makeColumnsResizable() {
  const table = getEl('clientsTable');
  if (!table) return;

  const cols = table.querySelectorAll('th');
  cols.forEach((col, idx) => {
    if (col.querySelector('.resizer') || idx === cols.length - 1) return;

    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    col.appendChild(resizer);

    let startX = 0;
    let startW = 0;

    resizer.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();

      startX = e.clientX;
      startW = col.offsetWidth;
      resizer.classList.add('resizing');

      const onMouseMove = (moveEvent) => {
        moveEvent.stopPropagation();
        moveEvent.preventDefault();
        const nw = Math.max(50, startW + (moveEvent.clientX - startX));
        col.style.width = `${nw}px`;
        col.style.minWidth = `${nw}px`;
      };

      const onMouseUp = (upEvent) => {
        upEvent.stopPropagation();
        upEvent.preventDefault();
        resizer.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
      };

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    });

    resizer.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
  });
}

function showCuotasModal(polizaId, operacion) {
  let targetPoliza = null;
  let targetCliente = null;

  for (const c of (state.clients || [])) {
    for (const p of (c.polizas || [])) {
      if (p.id === polizaId || p.operacion === operacion) {
        targetPoliza = p;
        targetCliente = c;
        break;
      }
    }
    if (targetPoliza) break;
  }

  const modal = getEl('modalCuotasHistorial');
  const title = getEl('modalCuotasTitle');
  const content = getEl('modalCuotasContent');
  if (!modal || !content) return;

  const opStr = targetPoliza ? (targetPoliza.operacion || operacion) : operacion;
  const clienteName = targetCliente ? formatClientName(targetCliente.nombre || '') : '';

  if (title) {
    title.innerHTML = `<span>🧾</span> <span>Historial de Cuotas NRE — Póliza N° ${escapeHtml(opStr)}</span>`;
  }

  let historial = [];
  if (targetPoliza && targetPoliza.cuotas_historial) {
    try {
      historial = JSON.parse(targetPoliza.cuotas_historial);
    } catch(e) {
      historial = [];
    }
  }

  // Fallback if no JSON history stored yet: construct 3 sample/estimated cuotas from DB values
  if (!historial || historial.length === 0) {
    const totalCuotas = targetPoliza ? (targetPoliza.total_cuotas || 3) : 3;
    const cuotasDebe = targetPoliza ? (targetPoliza.cuotas_debe || 0) : 0;
    const vtoCuota = targetPoliza ? targetPoliza.fecha_vencimiento : null;
    const saldo = targetPoliza ? (parseFloat(targetPoliza.saldo_pendiente) || 0) : 0;

    historial = [];
    for (let i = 1; i <= totalCuotas; i++) {
      const esImpaga = (i > (totalCuotas - cuotasDebe));
      historial.push({
        nro_cuota: i,
        vto_cuota: esImpaga ? vtoCuota : null,
        saldo_cli: esImpaga ? (saldo / Math.max(1, cuotasDebe)) : 0,
        estado: esImpaga ? 'PENDIENTE' : 'PAGADA',
        fecha_pago: esImpaga ? null : 'Registrado en NRE',
        lote: esImpaga ? '-' : 'Lote NRE Sincronizado'
      });
    }
  }

  let rowsHtml = '';
  historial.forEach(item => {
    const isPend = item.estado === 'PENDIENTE' || (item.saldo_cli > 0);
    const estadoBadge = getCuotaEstadoBadge(item);

    const vtoFormatted = item.vto_cuota ? formatDate(item.vto_cuota) : '-';
    const pagoFormatted = item.fecha_pago ? formatDate(item.fecha_pago) : (isPend ? '-' : 'Abonada');
    const saldoFormatted = item.saldo_cli > 0 
      ? `$ ${parseFloat(item.saldo_cli).toLocaleString('es-AR', { minimumFractionDigits:2, maximumFractionDigits:2 })}` 
      : '$ 0,00';
    const loteStr = item.lote || '-';

    rowsHtml += `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:10px 14px;"><strong>Cuota ${item.nro_cuota}</strong></td>
        <td style="padding:10px 14px;">${vtoFormatted}</td>
        <td style="padding:10px 14px;"><strong style="color:${isPend ? '#ff4757' : '#2ed573'};">${saldoFormatted}</strong></td>
        <td style="padding:10px 14px;">${estadoBadge}</td>
        <td style="padding:10px 14px; font-family:monospace; color:var(--text-secondary);">${pagoFormatted}</td>
        <td style="padding:10px 14px; font-family:monospace; color:var(--accent-cyan-light);">${escapeHtml(loteStr)}</td>
      </tr>
    `;
  });

  let grucarBadge = '<span class="badge" style="background:rgba(255,71,87,0.15); border:1px solid #ff4757; color:#ff4757; padding:4px 10px; border-radius:12px; font-size:0.78rem; font-weight:700;">🔴 Sin Cobertura Grucar</span>';
  if (targetPoliza && (targetPoliza.grucar_activo === 1 || targetPoliza.grucar_activo === '1' || targetPoliza.grucar_activo === true)) {
    if (targetPoliza.grucar_pendiente_sync === 1) {
      grucarBadge = '<span class="badge" style="background:rgba(255,165,2,0.15); border:1px solid #ffa502; color:#ffa502; padding:4px 10px; border-radius:12px; font-size:0.78rem; font-weight:700;">🟡 Pendiente Sync / Retry</span>';
    } else {
      grucarBadge = '<span class="badge" style="background:rgba(46,213,115,0.15); border:1px solid #2ed573; color:#2ed573; padding:4px 10px; border-radius:12px; font-size:0.78rem; font-weight:700;">🟢 Grucar Activo - OK</span>';
    }
  }

  content.innerHTML = `
    <div style="background:rgba(0,180,216,0.06); border:1px solid rgba(0,180,216,0.2); padding:12px 16px; border-radius:10px; margin-bottom:16px; font-size:0.88rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div><strong>Asegurado:</strong> ${escapeHtml(clienteName)}</div>
      <div><strong>Vehículo:</strong> ${escapeHtml(targetPoliza ? (targetPoliza.vehiculo || '-') : '-')}</div>
      <div><strong>Patente:</strong> <span style="font-family:monospace; font-weight:700;">${escapeHtml(targetPoliza ? (targetPoliza.patente || '-') : '-')}</span></div>
      <div><strong>Estado Grucar API:</strong> ${grucarBadge}</div>
    </div>
    <div class="table-container" style="max-height: 320px; overflow-y: auto;">
      <table style="width: 100%; border-collapse: collapse; font-size: 0.88rem;">
        <thead>
          <tr style="background: rgba(255,255,255,0.04); text-align: left;">
            <th style="padding: 10px 14px; color: var(--text-secondary);">CUOTA</th>
            <th style="padding: 10px 14px; color: var(--text-secondary);">VENCIMIENTO</th>
            <th style="padding: 10px 14px; color: var(--text-secondary);">SALDO CLI</th>
            <th style="padding: 10px 14px; color: var(--text-secondary);">ESTADO</th>
            <th style="padding: 10px 14px; color: var(--text-secondary);">FECHA PAGO</th>
            <th style="padding: 10px 14px; color: var(--text-secondary);">N° LOTE NRE</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;

  modal.style.display = 'flex';
}

function closeCuotasModal() {
  const modal = getEl('modalCuotasHistorial');
  if (modal) modal.style.display = 'none';
}

// REAL-TIME AUTO-SANITIZATION FOR ALL ADMIN PLATE INPUTS (MAYÚSCULAS, SIN ESPACIOS NI GUIONES)
document.addEventListener('input', (e) => {
  if (e.target && (e.target.id === 'clientPatente' || e.target.id === 'addAdminPatente' || e.target.name === 'patente' || e.target.classList.contains('input-patente'))) {
    e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }
});

// ─── GESTIÓN ADMINISTRATIVA DE COBRANZAS, CUOTAS & ACARREO ─────────────────
let adminCobranzasState = {
  items: [],
  filterEstado: 'TODOS',
  search: ''
};

function openModalAdminCobranzas(estado = 'TODOS') {
  adminCobranzasState.filterEstado = estado;
  const modal = getEl('modalAdminCobranzas');
  if (modal) modal.style.display = 'flex';
  fetchAdminCobranzas();
}

function closeModalAdminCobranzas() {
  const modal = getEl('modalAdminCobranzas');
  if (modal) modal.style.display = 'none';
}

function filterAdminCobranzas(estado) {
  adminCobranzasState.filterEstado = estado;
  document.querySelectorAll('.admin-filter-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = getEl(`btnFilterAdmin${estado}`);
  if (activeBtn) activeBtn.classList.add('active');
  fetchAdminCobranzas();
}

let searchAdminTimeout;
function debouncedSearchAdminCobranzas() {
  clearTimeout(searchAdminTimeout);
  searchAdminTimeout = setTimeout(() => {
    adminCobranzasState.search = getEl('adminSearchInput')?.value.trim() || '';
    fetchAdminCobranzas();
  }, 300);
}

async function fetchAdminCobranzas() {
  const tbody = getEl('adminCobranzasTableBody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center" style="padding:2rem;"><div class="loading"></div></td></tr>';
  }

  try {
    const url = `/api/admin/cobranzas?estado=${adminCobranzasState.filterEstado}&search=${encodeURIComponent(adminCobranzasState.search)}`;
    const res = await fetch(url);
    const data = await res.json();
    adminCobranzasState.items = data.items || [];
    renderAdminCobranzasTable();
  } catch (e) {
    console.error('Error fetching admin cobranzas:', e);
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center" style="color:var(--danger); padding:2rem;">Error al cargar las cobranzas administrativas.</td></tr>';
    }
  }
}

function renderAdminCobranzasTable() {
  const tbody = getEl('adminCobranzasTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (adminCobranzasState.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center" style="padding:2rem; color:var(--text-secondary);">No se encontraron cuotas para el filtro seleccionado.</td></tr>';
    return;
  }

  adminCobranzasState.items.forEach(c => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';

    const totalVal = (c.monto_total || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
    const polizaVal = (c.monto_poliza || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
    const acarreoVal = (c.monto_acarreo || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
    const fechaVto = c.fecha_vencimiento ? formatDate(c.fecha_vencimiento) : '-';

    let badgeHtml = '<span class="badge" style="background:rgba(241,196,15,0.2); color:#f39c12; border:1px solid rgba(241,196,15,0.4); font-weight:700;">🟡 PENDIENTE</span>';
    if (c.estado === 'PAGADO') {
      badgeHtml = '<span class="badge" style="background:rgba(46,213,115,0.2); color:#2ed573; border:1px solid rgba(46,213,115,0.4); font-weight:700;">🟢 PAGADO</span>';
    } else if (c.estado === 'VENCIDO') {
      badgeHtml = '<span class="badge" style="background:rgba(255,71,87,0.2); color:#ff4757; border:1px solid rgba(255,71,87,0.4); font-weight:700;">🔴 VENCIDO</span>';
    }

    const pdfNreBtn = `<a href="${c.pdf_nre_url || '/api/pdf/nre/' + c.id}" target="_blank" class="btn btn-sm btn-ghost" title="Ver/Descargar Recibo NRE Emisión" style="padding:4px 8px; color:#48cae4; border:1px solid rgba(0,180,216,0.3); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">📄 Recibo NRE</a>`;
    const pdfGrucarBtn = `<a href="${c.pdf_grucar_url || '/api/pdf/grucar/' + c.id}" target="_blank" class="btn btn-sm btn-ghost" title="Ver/Descargar Cupón Acarreo Grucar" style="padding:4px 8px; color:#2ed573; border:1px solid rgba(46,213,115,0.3); text-decoration:none; display:inline-flex; align-items:center; gap:4px;">🚗 Cupón Grucar</a>`;

    tr.innerHTML = `
      <td style="padding:10px 14px;">
        <strong style="color:#fff;">${escapeHtml(c.cliente_nombre || '-')}</strong>
        <div style="font-size:0.78rem; color:var(--text-secondary);">📱 ${escapeHtml(c.cliente_telefono || '-')}</div>
      </td>
      <td style="padding:10px 14px;">
        <span style="font-family:monospace; font-weight:800; color:var(--accent-cyan-light);">${escapeHtml(c.patente || '-')}</span>
        <div style="font-size:0.78rem; color:var(--text-secondary); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(c.vehiculo || '-')}</div>
      </td>
      <td style="padding:10px 14px; text-align:center; font-weight:800;">Cuota ${c.numero_cuota || 1}</td>
      <td style="padding:10px 14px; text-align:right; font-weight:600; color:#48cae4;">${polizaVal}</td>
      <td style="padding:10px 14px; text-align:right; font-weight:600; color:#ffa502;">${acarreoVal}</td>
      <td style="padding:10px 14px; text-align:right; font-weight:800; color:#2ed573; font-size:0.95rem;">${totalVal}</td>
      <td style="padding:10px 14px; text-align:center; font-weight:700;">${fechaVto}</td>
      <td style="padding:10px 14px; text-align:center;">${badgeHtml}</td>
      <td style="padding:10px 14px; text-align:center;">
        <div style="display:flex; align-items:center; justify-content:center; gap:6px; flex-wrap:wrap;">
          <button class="btn btn-sm btn-ghost" onclick="openModalEditarCuotaAdmin(${c.id})" title="Editar montos independientes de póliza y acarreo" style="padding:4px 8px;">✏️ Editar</button>
          <button class="btn btn-sm btn-ghost" onclick="generarLinkPagoAdmin(${c.id})" title="Generar link de MercadoPago" style="padding:4px 8px; color:var(--accent-cyan-light);">💳 Link</button>
          ${c.estado !== 'PAGADO' ? `<button class="btn btn-sm btn-ghost" onclick="simularPagoAdmin(${c.id})" title="Simular pago webhook (Testeo)" style="padding:4px 8px; color:#2ed573; border:1px solid rgba(46,213,115,0.4);">⚡ Pagado</button>` : `${pdfNreBtn} ${pdfGrucarBtn}`}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openModalEditarCuotaAdmin(id) {
  const cuota = adminCobranzasState.items.find(c => c.id === id);
  if (!cuota) return;

  getEl('editCuotaAdminId').value = cuota.id;
  getEl('editCuotaAdminCliente').innerText = `${cuota.cliente_nombre || '-'} (Póliza N° ${cuota.operacion || '-'})`;
  getEl('editCuotaAdminVehiculo').innerText = `Patente ${cuota.patente || '-'} — ${cuota.vehiculo || '-'}`;
  getEl('inputEditMontoPoliza').value = cuota.monto_poliza || 0;
  getEl('inputEditMontoAcarreo').value = cuota.monto_acarreo || 0;
  getEl('inputEditFechaVencimiento').value = cuota.fecha_vencimiento || '';
  getEl('selectEditEstadoCuota').value = cuota.estado || 'PENDIENTE';

  recalcularMontoTotalAdmin();

  const modal = getEl('modalEditarCuotaAdmin');
  if (modal) modal.style.display = 'flex';
}

function closeModalEditarCuotaAdmin() {
  const modal = getEl('modalEditarCuotaAdmin');
  if (modal) modal.style.display = 'none';
}

function recalcularMontoTotalAdmin() {
  const pol = parseFloat(getEl('inputEditMontoPoliza')?.value || 0);
  const aca = parseFloat(getEl('inputEditMontoAcarreo')?.value || 0);
  const total = Math.round((pol + aca) * 100) / 100;
  const display = getEl('displayMontoTotalCalculado');
  if (display) {
    display.innerText = total.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
  }
}

async function guardarEdicionCuotaAdmin(e) {
  e.preventDefault();
  const id = getEl('editCuotaAdminId')?.value;
  const monto_poliza = parseFloat(getEl('inputEditMontoPoliza')?.value || 0);
  const monto_acarreo = parseFloat(getEl('inputEditMontoAcarreo')?.value || 0);
  const fecha_vencimiento = getEl('inputEditFechaVencimiento')?.value;
  const estado = getEl('selectEditEstadoCuota')?.value;

  if (!id) return;

  try {
    const res = await fetch(`/api/admin/cuotas/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monto_poliza, monto_acarreo, fecha_vencimiento, estado })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error actualizando cuota');

    closeModalEditarCuotaAdmin();
    showToast('✏️ Montos de cuotas actualizados correctamente', 'success');
    fetchAdminCobranzas();
    fetchStats();
    fetchClientes();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function simularPagoAdmin(id) {
  if (!confirm('¿Simular webhook de pago y marcar esta cuota como PAGADA?')) return;
  try {
    const res = await fetch(`/api/admin/cuotas/${id}/simular-pago`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast('⚡ Pago simulado correctamente (Estado: PAGADO)', 'success');
    fetchAdminCobranzas();
    fetchStats();
    fetchClientes();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function generarLinkPagoAdmin(id) {
  try {
    const res = await fetch(`/api/admin/cuotas/${id}/link-pago`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    prompt('💳 Link de MercadoPago generado (Copia para enviar al cliente):', data.link_pago);
    showToast('💳 Link de MercadoPago generado', 'success');
    fetchAdminCobranzas();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function openModalNuevoClienteAdmin() {
  const modal = getEl('modalNuevoClienteAdmin');
  if (modal) modal.style.display = 'flex';
  const vtoInput = getEl('addAdminVencimiento');
  if (vtoInput && !vtoInput.value) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    vtoInput.value = d.toISOString().split('T')[0];
  }
  const polInput = getEl('addAdminMontoPoliza');
  if (polInput) polInput.value = 30240;
  const acaInput = getEl('addAdminMontoAcarreo');
  if (acaInput) acaInput.value = 1760;
}

function closeModalNuevoClienteAdmin() {
  const modal = getEl('modalNuevoClienteAdmin');
  if (modal) modal.style.display = 'none';
}

async function guardarNuevoClienteAdmin(e) {
  e.preventDefault();
  const nombre_completo = getEl('addAdminNombre')?.value.trim();
  const telefono_whatsapp = getEl('addAdminTelefono')?.value.trim();
  const patente_dominio = getEl('addAdminPatente')?.value.trim();
  const vehiculo_modelo = getEl('addAdminVehiculo')?.value.trim();
  const aseguradora = getEl('addAdminAseguradora')?.value.trim();
  const frecuencia_renovacion = getEl('addAdminFrecuencia')?.value;
  const monto_poliza = parseFloat(getEl('addAdminMontoPoliza')?.value || 0);
  const monto_acarreo = parseFloat(getEl('addAdminMontoAcarreo')?.value || 0);
  const fecha_vencimiento = getEl('addAdminVencimiento')?.value;

  try {
    // 1. Alta cliente
    const resCli = await fetch('/api/admin/clientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre_completo, telefono_whatsapp })
    });
    const dataCli = await resCli.json();
    if (!resCli.ok) throw new Error(dataCli.error);

    // 2. Alta póliza
    const resPol = await fetch('/api/admin/polizas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: dataCli.id,
        patente_dominio,
        vehiculo_modelo,
        aseguradora,
        frecuencia_renovacion,
        monto_poliza,
        monto_acarreo,
        fecha_vencimiento
      })
    });
    const dataPol = await resPol.json();
    if (!resPol.ok) throw new Error(dataPol.error);

    closeModalNuevoClienteAdmin();
    showToast('🎉 Cliente y Póliza dados de alta exitosamente', 'success');
    fetchAdminCobranzas();
    fetchStats();
    fetchClientes();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
