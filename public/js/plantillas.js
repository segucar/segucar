/**
 * plantillas.js - Gestor de plantillas de mensajes WhatsApp para SEGUCar
 */

let currentPlantillas = [];

document.addEventListener('DOMContentLoaded', async () => {
    await loadPlantillas();
});

async function loadPlantillas() {
    const grid = document.getElementById('plantillasGrid');
    if (!grid) return;

    try {
        grid.innerHTML = '<div class="loading"></div>';
        const res = await fetch('/api/plantillas');
        if (!res.ok) throw new Error('Error al cargar plantillas');

        currentPlantillas = await res.json();
        renderPlantillas(currentPlantillas);
    } catch (e) {
        showToast('Error cargando plantillas: ' + e.message, 'error');
        grid.innerHTML = '<p class="empty-state">No se pudieron cargar las plantillas.</p>';
    }
}

function renderPlantillas(plantillas) {
    const grid = document.getElementById('plantillasGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!plantillas || plantillas.length === 0) {
        grid.innerHTML = '<p class="empty-state">No hay plantillas configuradas.</p>';
        return;
    }

    plantillas.forEach(p => {
        const card = document.createElement('div');
        card.className = 'template-card';
        card.dataset.id = p.id;

        const badgeClass = p.tipo === 'vencimiento' ? 'badge-por-vencer' : 
                           p.tipo === 'deuda' ? 'badge-deuda' : 
                           p.tipo === 'recuperacion' ? 'badge-vencida' : 'badge-vigente';

        const tipoText = p.tipo === 'vencimiento' ? 'VENCIMIENTO' : 
                         p.tipo === 'deuda' ? 'COBRANZA' : 
                         p.tipo === 'recuperacion' ? 'RECUPERACIÓN' : 'RENOVACIÓN';

        card.innerHTML = `
            <div class="template-header">
                <input type="text" class="template-title-input" value="${escapeHtml(p.nombre)}" title="${escapeHtml(p.nombre)}" id="nombre_${p.id}" onchange="updatePreview(${p.id})">
                <span class="badge ${badgeClass}">${tipoText}</span>
            </div>

            <div class="form-group mb-1">
                <label>Mensaje de WhatsApp</label>
                <textarea id="texto_${p.id}" class="form-control" oninput="updatePreview(${p.id})" style="height: 110px;">${escapeHtml(p.mensaje)}</textarea>
            </div>

            <div class="preview-box">
                <label>💬 Vista Previa de envío</label>
                <div id="preview_${p.id}"></div>
            </div>

            <div class="flex flex-between flex-center mt-2">
                <label style="cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 0.9rem;">
                    <input type="checkbox" ${p.activa ? 'checked' : ''} id="activa_${p.id}" onchange="toggleActive(${p.id}, this.checked)" style="width: 18px; height: 18px; cursor: pointer;">
                    ${p.activa ? '✅ Activa' : '❌ Inactiva'}
                </label>
                <div class="flex gap-2">
                    <button class="btn btn-primary" onclick="savePlantilla(${p.id})">💾 Guardar Cambios</button>
                </div>
            </div>
        `;
        grid.appendChild(card);
        updatePreview(p.id);
    });
}

function updatePreview(id) {
    const textEl = document.getElementById(`texto_${id}`);
    const previewEl = document.getElementById(`preview_${id}`);
    if (!textEl || !previewEl) return;

    let msg = textEl.value
        .replace(/\{nombre\}/g, 'Juan Pérez')
        .replace(/\{operacion\}/g, '11844628')
        .replace(/\{vehiculo\}/g, 'FORD FIESTA 1.6')
        .replace(/\{patente\}/g, 'GTJ524')
        .replace(/\{tipo_seguro\}/g, 'FORD FIESTA 1.6')
        .replace(/\{cuotas_debe\}/g, '2')
        .replace(/\{fecha_vencimiento\}/g, '15/08/2026');

    previewEl.innerText = msg;
}

async function savePlantilla(id) {
    const nombre = document.getElementById(`nombre_${id}`)?.value;
    const mensaje = document.getElementById(`texto_${id}`)?.value;
    const activa = document.getElementById(`activa_${id}`)?.checked ? 1 : 0;

    const p = currentPlantillas.find(x => x.id === id);
    const tipo = p ? p.tipo : 'vencimiento';

    try {
        const res = await fetch(`/api/plantillas/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre, tipo, mensaje, activa })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showToast('Plantilla guardada correctamente', 'success');
        await loadPlantillas();
    } catch (err) {
        showToast('Error al guardar: ' + err.message, 'error');
    }
}

async function toggleActive(id, isActive) {
    const p = currentPlantillas.find(x => x.id === id);
    if (!p) return;

    try {
        const res = await fetch(`/api/plantillas/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: p.nombre,
                tipo: p.tipo,
                mensaje: p.mensaje,
                activa: isActive ? 1 : 0
            })
        });

        if (!res.ok) throw new Error('Error al cambiar estado');
        showToast(`Plantilla ${isActive ? 'activada' : 'desactivada'}`, 'success');
        p.activa = isActive ? 1 : 0;
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

async function addPlantilla() {
    const nombre = prompt('Nombre de la nueva plantilla:');
    if (!nombre) return;

    try {
        const res = await fetch('/api/plantillas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre,
                tipo: 'vencimiento',
                mensaje: 'Hola, te saludamos de SEGUCar...',
                activa: 1
            })
        });

        if (!res.ok) throw new Error('Error al crear plantilla');
        showToast('Nueva plantilla creada', 'success');
        await loadPlantillas();
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
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
