let currentCuotaId = null;
let currentCuotaData = null;

document.addEventListener('DOMContentLoaded', () => {
  const pathParts = window.location.pathname.split('/');
  const idFromPath = pathParts[pathParts.length - 1];
  const urlParams = new URLSearchParams(window.location.search);
  const idFromQuery = urlParams.get('id');

  if (idFromPath && !isNaN(parseInt(idFromPath))) {
    currentCuotaId = parseInt(idFromPath);
  } else if (idFromQuery && !isNaN(parseInt(idFromQuery))) {
    currentCuotaId = parseInt(idFromQuery);
  } else {
    currentCuotaId = 1540; // Default sample ID for direct preview
  }

  const tabQuery = urlParams.get('tab');
  if (tabQuery === 'comprobantes') {
    switchPublicTab('comprobantes');
  }

  fetchCuotaPublica(currentCuotaId);
});

function switchPublicTab(tab) {
  const secPago = document.getElementById('sectionPago');
  const secComp = document.getElementById('sectionComprobantes');
  const tabPago = document.getElementById('tabPago');
  const tabComp = document.getElementById('tabComprobantes');

  if (tab === 'pago') {
    if (secPago) secPago.style.display = 'block';
    if (secComp) secComp.style.display = 'none';
    if (tabPago) tabPago.classList.add('active');
    if (tabComp) tabComp.classList.remove('active');
  } else {
    if (secPago) secPago.style.display = 'none';
    if (secComp) secComp.style.display = 'block';
    if (tabPago) tabPago.classList.remove('active');
    if (tabComp) tabComp.classList.add('active');

    // Auto trigger search if patente is loaded
    if (currentCuotaData && currentCuotaData.patente) {
      const input = document.getElementById('inputBuscarPatente');
      if (input && !input.value) {
        input.value = currentCuotaData.patente;
        buscarComprobantesCliente();
      }
    }
  }
}

async function fetchCuotaPublica(id) {
  const loading = document.getElementById('pagoLoading');
  const content = document.getElementById('pagoContent');

  try {
    const res = await fetch(`/api/public/cuotas/${id}`);
    if (!res.ok) throw new Error('Cuota no encontrada');
    const data = await res.json();
    currentCuotaData = data;

    // Render Data
    document.getElementById('valClienteNombre').innerText = data.cliente_nombre || '-';
    document.getElementById('valPatente').innerText = data.patente || '-';
    document.getElementById('valVehiculo').innerText = data.vehiculo || '-';
    document.getElementById('valVencimiento').innerText = formatDate(data.fecha_vencimiento);

    document.getElementById('valMontoPoliza').innerText = formatCurrency(data.monto_poliza);
    document.getElementById('valMontoAcarreo').innerText = formatCurrency(data.monto_acarreo);
    document.getElementById('valMontoTotal').innerText = formatCurrency(data.monto_total);

    const contPago = document.getElementById('containerAccionesPago');
    const contPagada = document.getElementById('containerCuotaPagada');

    if (data.estado === 'PAGADO') {
      if (contPago) contPago.style.display = 'none';
      if (contPagada) contPagada.style.display = 'block';

      const btnNre = document.getElementById('linkPdfNre');
      const btnGrucar = document.getElementById('linkPdfGrucar');
      if (btnNre) btnNre.href = data.pdf_nre_url || `/api/pdf/nre/${data.id}`;
      if (btnGrucar) btnGrucar.href = data.pdf_grucar_url || `/api/pdf/grucar/${data.id}`;
    } else {
      if (contPago) contPago.style.display = 'block';
      if (contPagada) contPagada.style.display = 'none';
    }

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
  } catch (e) {
    if (loading) {
      loading.innerHTML = `<div style="color:#ff4757; font-weight:700;">⚠️ ${e.message}</div>`;
    }
  }
}

function pagarConMercadoPago() {
  if (currentCuotaData && currentCuotaData.link_pago) {
    window.open(currentCuotaData.link_pago, '_blank');
  } else {
    alert('Link de MercadoPago no disponible.');
  }
}

async function simularPagoCliente() {
  if (!currentCuotaId) return;

  const btnSim = document.getElementById('btnSimularPago');
  if (btnSim) {
    btnSim.disabled = true;
    btnSim.innerText = '⏳ Procesando pago...';
  }

  try {
    const res = await fetch(`/api/public/cuotas/${currentCuotaId}/simular-pago`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al procesar pago');

    alert('¡Pago recibido con éxito! Se han generado sus 2 comprobantes permanentes (NRE + Grucar).');
    fetchCuotaPublica(currentCuotaId);
  } catch (err) {
    alert('Error: ' + err.message);
    if (btnSim) {
      btnSim.disabled = false;
      btnSim.innerText = '⚡ Simular Pago Inmediato (Sandbox Test)';
    }
  }
}

async function buscarComprobantesCliente() {
  const input = document.getElementById('inputBuscarPatente');
  const term = input ? input.value.trim() : '';
  const container = document.getElementById('comprobantesResultados');

  if (!term) {
    alert('Por favor ingrese una patente o DNI.');
    return;
  }

  if (container) {
    container.innerHTML = '<div style="text-align:center; padding:20px;"><div class="loading" style="margin:0 auto;"></div></div>';
  }

  try {
    const res = await fetch(`/api/public/comprobantes?patente=${encodeURIComponent(term)}`);
    const data = await res.json();
    const items = data.items || [];

    if (items.length === 0) {
      container.innerHTML = `<div style="text-align:center; color:#94a3b8; padding:30px 0;">No se encontraron cuotas pagadas para "${escapeHtml(term)}".</div>`;
      return;
    }

    let html = '';
    items.forEach(item => {
      html += `
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px; margin-bottom: 12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
            <strong style="color:#fff; font-size:0.95rem;">${escapeHtml(item.cliente_nombre || '-')} &bull; <span style="color:#38bdf8; font-family:monospace;">${escapeHtml(item.patente || '-')}</span></strong>
            <span class="badge" style="background:rgba(46,213,115,0.15); color:#2ed573; border:1px solid rgba(46,213,115,0.3); font-weight:700;">✅ PAGADO</span>
          </div>
          <div style="font-size:0.83rem; color:#94a3b8; margin-bottom: 12px;">
            Cuota N° ${item.numero_cuota || 1} &bull; Vencimiento: ${formatDate(item.fecha_vencimiento)} &bull; Monto Total: <strong style="color:#fff;">${formatCurrency(item.monto_total || 32000)}</strong>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <a href="/api/pdf/nre/${item.id}" target="_blank" class="receipt-btn" style="padding:8px 12px; font-size:0.8rem;">📄 Recibo NRE</a>
            <a href="/api/pdf/grucar/${item.id}" target="_blank" class="receipt-btn" style="padding:8px 12px; font-size:0.8rem; border-color:rgba(46,213,115,0.4); color:#2ed573;">🚗 Cupón Grucar</a>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="color:#ff4757; text-align:center; padding:20px;">Error al buscar comprobantes: ${e.message}</div>`;
  }
}

function formatCurrency(amount) {
  const num = parseFloat(amount || 0);
  return '$ ' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const clean = String(dateStr).split('T')[0].split(' ')[0];
  const parts = clean.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
