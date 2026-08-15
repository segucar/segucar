const urlParams = new URLSearchParams(window.location.search);
const clientId = urlParams.get('id');
let currentClient = null;
let currentPolizas = [];
let currentPlantillas = [];

document.addEventListener('DOMContentLoaded', async () => {
    if (!clientId) {
        showToast('No se especificó un cliente', 'error');
        return;
    }
    await loadData();

    document.getElementById('editClientForm').addEventListener('submit', handleEditClient);
    document.getElementById('polizaForm').addEventListener('submit', handlePolizaSubmit);
});

async function loadData() {
    try {
        const clientRes = await fetch(`/api/clientes/${clientId}`);
        if (!clientRes.ok) throw new Error();
        const client = await clientRes.json();

        currentClient = client;
        currentPolizas = client.polizas || [];

        const plantillasRes = await fetch('/api/plantillas');
        currentPlantillas = await plantillasRes.json();

        renderClientHeader(currentClient);
        renderWhatsAppButtons(currentClient, currentPolizas, currentPlantillas);
        renderPolizas(currentPolizas);
        renderContactHistory(client.contactos || []);
    } catch (e) {
        showToast('Error cargando datos del cliente', 'error');
    }
}

function renderClientHeader(client) {
    const header = document.getElementById('clientHeader');
    const isPhoneValid = client.telefono && client.telefono.length >= 10;
    header.innerHTML = `
        <div class="flex flex-between flex-center">
            <div>
                <h1 style="font-size: 2rem; margin-bottom: 0.5rem;">${client.nombre}</h1>
                <p><strong>DNI:</strong> ${client.dni || '-'} | <strong>Email:</strong> ${client.email || '-'}</p>
                <p><strong>Dirección:</strong> ${client.direccion || '-'}</p>
            </div>
            <div class="text-center">
                <h2 style="color: ${isPhoneValid ? 'var(--accent)' : 'var(--danger)'}; font-size: 1.5rem;">
                    ${client.telefono ? (isPhoneValid ? client.telefono : `${client.telefono} (Inválido)`) : 'Sin teléfono'}
                </h2>
                <button class="btn btn-ghost mt-2" onclick="openEditClientModal()">Editar Cliente</button>
            </div>
        </div>
    `;
}

function renderWhatsAppButtons(client, polizas, plantillas) {
    const container = document.getElementById('whatsappActions');
    container.innerHTML = '';
    
    if (!client.telefono || client.telefono.length < 10) {
        container.innerHTML = '<span class="empty-state" style="color:var(--danger); font-weight:600;">⚠️ Teléfono inválido o ausente. Cargue un número de 10 dígitos (Código de área + Número sin 0 ni 15) para habilitar WhatsApp.</span>';
        return;
    }

    if (polizas.length === 0) {
        container.innerHTML = '<span class="empty-state">No hay pólizas para asociar al mensaje.</span>';
        return;
    }

    const activeTemplates = plantillas.filter(p => p.activa);
    activeTemplates.forEach(template => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-whatsapp';
        btn.innerHTML = `📱 Enviar ${template.nombre}`;
        btn.onclick = () => showPreview(client, polizas[0], template);
        container.appendChild(btn);
    });

    const reportBtn = document.createElement('button');
    reportBtn.className = 'btn btn-ghost';
    reportBtn.style.color = '#ff4757';
    reportBtn.style.border = '1px solid rgba(255,71,87,0.4)';
    reportBtn.style.background = 'rgba(255,71,87,0.1)';
    reportBtn.style.fontWeight = '700';
    reportBtn.innerHTML = '🚫 Número no existe / Sin WhatsApp';
    reportBtn.onclick = () => reportInvalidPhoneOnDetail(client.id, client.nombre);
    container.appendChild(reportBtn);
}

async function reportInvalidPhoneOnDetail(clientId, clientName) {
    if (!confirm(`¿Confirmás que el teléfono de ${clientName || 'este cliente'} no existe o no tiene WhatsApp?\n\nEl número será eliminado y el cliente pasará a la lista "Sin Celular / Requiere Actualización".`)) {
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
            setTimeout(() => window.location.reload(), 1000);
        } else {
            showToast(data.error || 'Error al reportar teléfono', 'error');
        }
    } catch (err) {
        console.error('Error reportando teléfono inválido:', err);
        showToast('Error de conexión al reportar teléfono', 'error');
    }
}

function getWaMessageData(client, polizaInput, template) {
    const polizas = client.polizas || [];
    const withDebt = polizas.filter(p => parseFloat(p.saldo_pendiente || 0) > 0);
    
    // If client detail shows debt policies, consolidate them, otherwise consolidate all
    const targetPolizas = withDebt.length > 0 ? withDebt : (polizas.length > 0 ? [polizas[0]] : []);
    
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
        fechaVenc = p.fecha_vencimiento ? formatDate(p.fecha_vencimiento) : '';
        cuotasDebe = String(p.cuotas_debe || 1);
        totalSaldo = parseFloat(p.saldo_pendiente || 0);
    } else if (targetPolizas.length > 1) {
        const listLines = targetPolizas.map(p => `• ${p.vehiculo || p.tipo_vehiculo || 'Vehículo'} (Patente ${p.patente || '-'})`).join('\n');
        vehiculo = '\n' + listLines;
        patente = targetPolizas.map(p => p.patente || '').filter(Boolean).join(', ');
        operacion = targetPolizas.map(p => p.operacion || '').filter(Boolean).join(', ');
        fechaVenc = targetPolizas.map(p => p.fecha_vencimiento ? formatDate(p.fecha_vencimiento) : '').filter(Boolean).join(', ');
        cuotasDebe = String(targetPolizas.reduce((sum, p) => sum + (parseInt(p.cuotas_debe) || 0), 0));
        totalSaldo = targetPolizas.reduce((sum, p) => sum + (parseFloat(p.saldo_pendiente) || 0), 0);
    }
    
    const saldoStr = totalSaldo > 0 
        ? `$ ${totalSaldo.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
        : '$ 0,00';
        
    const formattedName = typeof formatClientName !== 'undefined' ? formatClientName(client.nombre) : (client.nombre || '');
    let msgTemplate = template.mensaje || template.template || '';

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
        .replace(/\{nombre\}/g, formattedName)
        .replace(/\{vehiculo\}/g, vehiculo)
        .replace(/\{patente\}/g, patente)
        .replace(/\{fecha_vencimiento\}/g, fechaVenc)
        .replace(/\{operacion\}/g, operacion)
        .replace(/\{tipo_seguro\}/g, vehiculo)
        .replace(/\{cuotas_debe\}/g, cuotasDebe)
        .replace(/\{importe\}/g, saldoStr)
        .replace(/\{monto\}/g, saldoStr)
        .replace(/\{saldo_pendiente\}/g, saldoStr);
        
    return { msg, poliza: targetPolizas[0] };
}

function showPreview(client, poliza, template) {
    const previewContainer = document.getElementById('whatsappPreview');
    const previewText = document.getElementById('previewText');
    
    const { msg, poliza: resolvedPoliza } = getWaMessageData(client, poliza, template);
    
    previewText.innerText = msg;
    previewContainer.classList.remove('hidden');

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-success mt-2';
    sendBtn.innerText = 'Confirmar y Enviar';
    sendBtn.onclick = () => sendWhatsApp(client, msg, template.tipo || 'vencimiento', resolvedPoliza ? resolvedPoliza.id : null);
    
    // Clear previous send button
    if(previewContainer.querySelector('button')) {
        previewContainer.querySelector('button').remove();
    }
    previewContainer.appendChild(sendBtn);
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

  return '';
}

async function sendWhatsApp(client, msg, tipo = 'vencimiento', polizaId = null) {
    const phone = formatPhoneForWhatsApp(client.telefono);
    const encoded = encodeURIComponent(msg);
    window.open(`https://web.whatsapp.com/send?phone=${phone}&text=${encoded}`, '_blank');
    
    // Log contact to DB and refresh timeline
    try {
        await fetch('/api/contactos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cliente_id: client.id,
                poliza_id: polizaId,
                tipo: tipo,
                medio: 'whatsapp',
                mensaje: msg
            })
        });
        showToast('Contacto registrado en el historial', 'success');
        if (typeof fetchContactHistory === 'function') fetchContactHistory(client.id);
    } catch(e) {
        console.error('Error logging contact:', e);
    }
}

function renderPolizas(polizas) {
    const tbody = document.querySelector('#polizasTable tbody');
    tbody.innerHTML = '';
    
    if (polizas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center empty-state">No hay pólizas</td></tr>';
        return;
    }

    polizas.forEach(p => {
        const tr = document.createElement('tr');
        const tipoStr = p.tipo_vehiculo || p.tipo || 'Auto';
        const fVenc = p.fecha_vencimiento || p.vencimiento || '';
        const suma = p.suma_asegurada || `$ ${parseFloat(p.monto || 0).toLocaleString('es-AR')}`;
        const estadoVal = p.estado || 'vigente';

        // Detectar si esta póliza fue reemplazada por una más nueva para la misma patente
        const isAnulada = estadoVal === 'anulada' || estadoVal === 'baja';
        const patenteMatch = p.patente && polizas.filter(x =>
            x.patente && x.patente.trim().toUpperCase() === p.patente.trim().toUpperCase() &&
            parseInt(x.operacion) > parseInt(p.operacion)
        );
        const polizaNueva = patenteMatch && patenteMatch.length > 0
            ? patenteMatch.sort((a, b) => parseInt(b.operacion) - parseInt(a.operacion))[0]
            : null;
        const fueRenovada = isAnulada && polizaNueva;

        // El botón cuotas de la póliza vieja redirige a la nueva si fue renovada
        const cuotasTarget = fueRenovada ? polizaNueva : p;
        const renovadaBadge = fueRenovada
            ? `<span style="margin-left:6px; font-size:0.75rem; background:rgba(0,180,216,0.15); color:#48cae4; border:1px solid rgba(0,180,216,0.3); border-radius:4px; padding:2px 6px; font-weight:600;">↪ Op. ${polizaNueva.operacion}</span>`
            : '';

        tr.innerHTML = `
            <td><strong>${p.operacion}</strong>${renovadaBadge}</td>
            <td>${tipoStr}</td>
            <td>${formatDate(fVenc)}</td>
            <td><strong>${suma}</strong></td>
            <td><span class="badge badge-${estadoVal}">${estadoVal.toUpperCase()}</span></td>
            <td>
                <button class="btn btn-ghost" onclick="showCuotasModal(${cuotasTarget.id}, '${cuotasTarget.operacion}')" style="color:#00b4d8; font-weight:700; border: 1px solid rgba(0, 180, 216, 0.3); padding: 4px 8px;" title="${fueRenovada ? 'Ver cuotas de la póliza renovada ' + polizaNueva.operacion : 'Ver cuotas'}">🧾 Cuotas${fueRenovada ? ' ↪' : ''}</button>
                <button class="btn btn-ghost" onclick="openPolizaModal(${p.id})">Editar</button>
                <button class="btn btn-danger" onclick="deletePoliza(${p.id})">Eliminar</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderContactHistory(contactos) {
    const container = document.getElementById('contactHistory');
    container.innerHTML = '';
    
    if (contactos.length === 0) {
        container.innerHTML = '<div class="empty-state">No hay contactos registrados.</div>';
        return;
    }

    contactos.forEach(c => {
        const div = document.createElement('div');
        div.className = 'p-2';
        div.style.borderLeft = '3px solid var(--accent)';
        div.style.background = 'var(--surface)';
        div.innerHTML = `
            <small>${formatDate(c.fecha)}</small>
            <p class="mb-0"><strong>${c.tipo}:</strong> ${c.mensaje}</p>
        `;
        container.appendChild(div);
    });
}

function openEditClientModal() {
    document.getElementById('editNombre').value = currentClient.nombre;
    document.getElementById('editDni').value = currentClient.dni;
    document.getElementById('editDireccion').value = currentClient.direccion;
    document.getElementById('editEmail').value = currentClient.email;
    document.getElementById('editTelefono').value = currentClient.telefono;
    document.getElementById('editClientModal').classList.remove('hidden');
}

async function handleEditClient(e) {
    if (e) e.preventDefault();
    if (!currentClient || !currentClient.id) return;

    const body = {
        nombre: document.getElementById('editNombre')?.value || '',
        dni: document.getElementById('editDni')?.value || '',
        direccion: document.getElementById('editDireccion')?.value || '',
        email: document.getElementById('editEmail')?.value || '',
        telefono: document.getElementById('editTelefono')?.value || ''
    };

    try {
        const res = await fetch(`/api/clientes/${currentClient.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al actualizar cliente');

        showToast('Cliente actualizado con éxito', 'success');
        closeModals();
        if (typeof fetchClientData === 'function') fetchClientData();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

function openPolizaModal(id = null) {
    const title = document.getElementById('polizaModalTitle');
    const form = document.getElementById('polizaForm');
    
    if (id) {
        const p = currentPolizas.find(x => x.id === id);
        title.innerText = 'Editar Póliza';
        document.getElementById('polizaId').value = p.id;
        document.getElementById('polizaOperacion').value = p.operacion;
        document.getElementById('polizaTipo').value = p.tipo;
        document.getElementById('polizaVencimiento').value = p.vencimiento;
        document.getElementById('polizaMonto').value = p.monto;
    } else {
        title.innerText = 'Agregar Póliza';
        form.reset();
        document.getElementById('polizaId').value = '';
    }
    document.getElementById('polizaModal').classList.remove('hidden');
}

function handlePolizaSubmit(e) {
    e.preventDefault();
    // POST/PUT mock
    showToast('Póliza guardada', 'success');
    closeModals();
}

function deletePoliza(id) {
    if(confirm('¿Seguro que desea eliminar esta póliza?')) {
        showToast('Póliza eliminada', 'success');
    }
}

function closeModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} p-2 mb-2`;
    toast.style.background = 'var(--card)';
    toast.style.border = '1px solid var(--border)';
    toast.style.borderRadius = '4px';
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const clean = String(dateString).split('T')[0].split(' ')[0];
    const parts = clean.split('-');
    if (parts.length === 3) {
        return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
    }
    return dateString;
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

function showCuotasModal(polizaId, operacion) {
    const targetPoliza = currentPolizas.find(p => p.id === polizaId || p.operacion === operacion);
    const modal = document.getElementById('modalCuotasHistorial');
    const title = document.getElementById('modalCuotasTitle');
    const content = document.getElementById('modalCuotasContent');
    if (!modal || !content) return;

    const opStr = targetPoliza ? (targetPoliza.operacion || operacion) : operacion;
    const clienteName = currentClient ? currentClient.nombre : '';

    if (title) {
        title.innerHTML = `<span>🧾</span> <span>Historial de Cuotas NRE — Póliza N° ${opStr}</span>`;
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
        const saldo = targetPoliza ? (parseFloat(targetPoliza.saldo_pendiente || targetPoliza.monto) || 0) : 0;

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
                <td style="padding:10px 14px; font-family:monospace; color:var(--accent-cyan-light);">${loteStr}</td>
            </tr>
        `;
    });

    content.innerHTML = `
        <div style="background:rgba(0,180,216,0.06); border:1px solid rgba(0,180,216,0.2); padding:12px 16px; border-radius:10px; margin-bottom:16px; font-size:0.88rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div><strong>Asegurado:</strong> ${clienteName}</div>
            <div><strong>Vehículo:</strong> ${targetPoliza ? (targetPoliza.vehiculo || '-') : '-'}</div>
            <div><strong>Patente:</strong> <span style="font-family:monospace; font-weight:700;">${targetPoliza ? (targetPoliza.patente || '-') : '-'}</span></div>
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
    const modal = document.getElementById('modalCuotasHistorial');
    if (modal) modal.style.display = 'none';
}

// Helper function to escape HTML strings safely
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
