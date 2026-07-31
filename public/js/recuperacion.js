let state = {
  items: [],
  pagination: { page: 1, limit: 50, pages: 1, total: 0 },
  search: '',
  filtro_telefono: 'todos',
  sort: { by: 'fecha_vencimiento', dir: 'DESC' }
};

document.addEventListener('DOMContentLoaded', () => {
  setupListeners();
  fetchRecuperacionItems();
});

function handleSortRecuperacion(col) {
  if (state.sort.by === col) {
    state.sort.dir = state.sort.dir === 'ASC' ? 'DESC' : 'ASC';
  } else {
    state.sort.by = col;
    state.sort.dir = 'ASC';
  }

  const cols = ['nombre', 'telefono', 'patente', 'operacion', 'vehiculo', 'fecha_vencimiento', 'estrategia', 'acciones'];
  cols.forEach(c => {
    const el = document.getElementById(`sort_icon_${c}`);
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
  fetchRecuperacionItems();
}

function changeFiltroTelefono(val) {
  state.filtro_telefono = val;
  state.pagination.page = 1;
  fetchRecuperacionItems();
}

function setupListeners() {
  const searchInput = document.getElementById('recuperacionSearchInput');
  if (searchInput) {
    let timeout;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        state.search = e.target.value.trim();
        state.pagination.page = 1;
        fetchRecuperacionItems();
      }, 300);
    });
  }
}

async function fetchRecuperacionItems() {
  const tbody = document.getElementById('recuperacionTableBody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:2rem;"><div class="loading"></div></td></tr>';
  }

  try {
    const url = `/api/recuperacion?search=${encodeURIComponent(state.search)}&filtro_telefono=${state.filtro_telefono}&page=${state.pagination.page}&limit=50&sort_by=${state.sort.by}&sort_dir=${state.sort.dir}`;
    const res = await fetch(url);
    const data = await res.json();

    state.items = data.items || [];
    state.pagination = { page: data.page, limit: 50, pages: data.pages, total: data.total };

    const elTotal = document.getElementById('totalRecuperacionCount');
    if (elTotal) {
      const stats = data.stats || {};
      const conTel = stats.con_telefono || 0;
      const sinTel = stats.sin_telefono || 0;
      elTotal.innerText = `${data.total.toLocaleString('es-AR')} Pólizas (${conTel} con celular / ${sinTel} sin celular)`;
    }

    renderTable();
    renderPagination();
  } catch (e) {
    console.error(e);
  }
}

function renderTable() {
  const tbody = document.getElementById('recuperacionTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (state.items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:2rem; color:var(--text-secondary);">No se encontraron pólizas en la cartera de recuperación.</td></tr>';
    return;
  }

  state.items.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = 'client-row';

    const fechaStr = item.fecha_vencimiento ? formatDate(item.fecha_vencimiento) : '-';
    const cleanPhone = item.telefono ? formatPhone(item.telefono) : null;
    const hasValidPhone = cleanPhone && cleanPhone.length >= 7;

    let prioridadBadge = '<span class="badge" style="background:rgba(255,71,87,0.15); color:#ff4757; border:1px solid rgba(255,71,87,0.3);">🔥 Prioridad Alta</span>';
    if (item.fecha_vencimiento && item.fecha_vencimiento > '2026-06-01') {
      prioridadBadge = '<span class="badge" style="background:rgba(255,165,2,0.15); color:#ffa502; border:1px solid rgba(255,165,2,0.3);">🟡 Prioridad Media</span>';
    } else if (item.fecha_vencimiento && item.fecha_vencimiento > '2026-09-01') {
      prioridadBadge = '<span class="badge" style="background:rgba(255,255,255,0.1); color:#94a3b8; border:1px solid rgba(255,255,255,0.2);">⚪ Prioridad Regular</span>';
    }

    const phoneColHtml = hasValidPhone
      ? `<span style="display:inline-flex; align-items:center; gap:6px;">📱 ${escapeHtml(cleanPhone)} <button class="btn btn-sm btn-ghost" onclick="openModalTelefono(${item.id}, '${escapeQuotes(item.nombre)}', '${escapeQuotes(item.telefono || '')}')" title="Editar celular" style="padding:2px 6px; font-size:0.75rem;">✏️</button></span>`
      : `<span style="display:inline-flex; align-items:center; gap:6px;"><span class="text-muted">📵 Sin teléfono</span> <button class="btn btn-sm btn-ghost" onclick="openModalTelefono(${item.id}, '${escapeQuotes(item.nombre)}', '')" title="Cargar celular" style="padding:2px 6px; font-size:0.75rem;">✏️</button></span>`;

    const accionesColHtml = hasValidPhone
      ? `
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="btn btn-sm btn-whatsapp" onclick="sendWinBackWhatsApp('${escapeQuotes(item.nombre)}', '${escapeQuotes(cleanPhone)}', '${escapeQuotes(item.vehiculo || '')}', '${escapeQuotes(item.patente || '')}')" title="Enviar propuesta de reactivación por WhatsApp">
            💬 Reactivar
          </button>
          <button class="btn btn-sm btn-ghost" onclick="openModalTelefono(${item.id}, '${escapeQuotes(item.nombre)}', '${escapeQuotes(item.telefono || '')}')" title="Editar número de teléfono">✏️</button>
        </div>
      `
      : `
        <button class="btn btn-sm btn-ghost" onclick="openModalTelefono(${item.id}, '${escapeQuotes(item.nombre)}', '')" style="border: 1px dashed rgba(0,180,216,0.5); color: var(--accent-cyan-light); font-weight:700; gap:4px; display:inline-flex; align-items:center; padding: 5px 12px;" title="Agregar celular para habilitar envío por WhatsApp">
          ➕ Agregar Celular
        </button>
      `;

    tr.innerHTML = `
      <td><strong>${escapeHtml(item.nombre || '-')}</strong></td>
      <td>${phoneColHtml}</td>
      <td><strong>${escapeHtml(item.patente || '-')}</strong></td>
      <td><span style="font-size:0.83rem; font-weight:700; color:var(--text-secondary); font-family:monospace; background:rgba(255,255,255,0.05); padding:3px 8px; border-radius:6px;">${escapeHtml(item.operacion || '-')}</span></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(item.vehiculo || '')}">${escapeHtml(item.vehiculo || '-')}</td>
      <td><span style="color:var(--danger); font-weight:600;">${fechaStr}</span></td>
      <td>${prioridadBadge}</td>
      <td>${accionesColHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

function openModalTelefono(id, nombre, telActual) {
  const modal = document.getElementById('modalEditarTelefono');
  const inputId = document.getElementById('editItemRecuperacionId');
  const elNombre = document.getElementById('editItemClienteNombre');
  const inputTel = document.getElementById('editInputTelefono');

  if (inputId) inputId.value = id;
  if (elNombre) elNombre.innerText = nombre || '-';
  if (inputTel) inputTel.value = telActual || '';

  if (modal) {
    modal.style.display = 'flex';
    if (inputTel) {
      setTimeout(() => inputTel.focus(), 100);
    }
  }
}

function closeModalTelefono() {
  const modal = document.getElementById('modalEditarTelefono');
  if (modal) modal.style.display = 'none';
}

async function guardarTelefonoRecuperacion(e) {
  e.preventDefault();
  const id = document.getElementById('editItemRecuperacionId')?.value;
  const telefono = document.getElementById('editInputTelefono')?.value;

  if (!id) return;

  try {
    const res = await fetch(`/api/recuperacion/${id}/telefono`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al guardar celular');

    closeModalTelefono();
    showToast('📱 Celular guardado correctamente', 'success');
    fetchRecuperacionItems();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function renderPagination() {
  const container = document.getElementById('paginationControls');
  if (!container) return;
  const { page, pages } = state.pagination;

  if (pages <= 1) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <button class="btn btn-sm btn-ghost" ${page === 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">← Ant</button>
    <span style="font-size:0.9rem; font-weight:600;">Página ${page} de ${pages}</span>
    <button class="btn btn-sm btn-ghost" ${page === pages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Sig →</button>
  `;
}

function goToPage(p) {
  if (p < 1 || p > state.pagination.pages) return;
  state.pagination.page = p;
  fetchRecuperacionItems();
}

function resetRecuperacionFilters() {
  state.search = '';
  state.filtro_telefono = 'todos';
  const searchInput = document.getElementById('recuperacionSearchInput');
  if (searchInput) searchInput.value = '';
  const selectTel = document.getElementById('selectFiltroTelefono');
  if (selectTel) selectTel.value = 'todos';
  state.pagination.page = 1;
  fetchRecuperacionItems();
}

function sendWinBackWhatsApp(nombre, telefono, vehiculo, patente, operacion) {
  const clean = formatPhoneForWhatsApp(telefono);
  const msg = `Hola, te saludamos de SEGUCar. Queremos ponernos en contacto nuevamente por tu póliza (Dominio: ${patente}). Contamos con nuevas propuestas y excelentes coberturas para reactivar tu seguro. ¡Consultanos sin compromiso!`;
  window.open(`https://web.whatsapp.com/send?phone=${clean}&text=${encodeURIComponent(msg)}`, '_blank');
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const clean = String(dateStr).split('T')[0].split(' ')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
  }
  return dateStr;
}

function formatPhone(phone) {
  return String(phone || '').replace(/[\s\-\(\)]/g, '');
}

function formatPhoneForWhatsApp(phone) {
  if (!phone) return '';
  let str = String(phone).replace(/[^\d]/g, '');
  if (!str) return '';

  if (str.startsWith('549')) {
    str = str.substring(3);
  } else if (str.startsWith('54')) {
    str = str.substring(2);
  }

  while (str.startsWith('0')) {
    str = str.substring(1);
  }

  if (str.startsWith('22315') && str.length >= 11) {
    str = '223' + str.substring(5);
  } else if (str.startsWith('15') && str.length === 9) {
    str = str.substring(2);
  }

  if (str.startsWith('2230') && str.length === 11) {
    str = '223' + str.substring(4);
  }

  if (str.length === 7 || str.length === 8) {
    str = '223' + str;
  }

  if (str.length === 10) {
    return '549' + str;
  }

  return str;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s ease-out reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeQuotes(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'");
}
