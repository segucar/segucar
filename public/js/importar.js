const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const importBtn = document.getElementById('importBtn');

let selectedFile = null;

// ─── Origin radio button styling ──────────────────────────────────────────
function actualizarEstiloOrigen() {
    const nreLabel = document.getElementById('origenNRELabel');
    const agsLabel = document.getElementById('origenAGSLabel');
    const esAGS = document.getElementById('origenAGS')?.checked;
    if (!nreLabel || !agsLabel) return;
    if (esAGS) {
        agsLabel.style.border = '2px solid #1565c0';
        agsLabel.style.background = 'rgba(21,101,192,0.15)';
        nreLabel.style.border = '2px solid #444';
        nreLabel.style.background = 'transparent';
        importBtn.textContent = '🔵 Importar como AGS';
    } else {
        nreLabel.style.border = '2px solid var(--accent-cyan)';
        nreLabel.style.background = 'rgba(0,180,216,0.1)';
        agsLabel.style.border = '2px solid #444';
        agsLabel.style.background = 'transparent';
        importBtn.textContent = '📥 Importar Archivo';
    }
}
document.querySelectorAll('input[name="origenImport"]').forEach(r => r.addEventListener('change', actualizarEstiloOrigen));

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFileSelect(e.dataTransfer.files[0]);
    }
});

// Click to browse
dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleFileSelect(e.target.files[0]);
    }
});

function handleFileSelect(file) {
    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
        showToast('Solo se permiten archivos Excel (.xlsx, .xls)', 'error');
        return;
    }
    selectedFile = file;
    document.getElementById('fileName').innerText = file.name;
    document.getElementById('fileSize').innerText = (file.size / 1024 / 1024).toFixed(2) + ' MB';
    fileInfo.classList.remove('hidden');
    importBtn.classList.remove('hidden');
}

async function uploadExcel() {
    if (!selectedFile) return;

    const origenRadio = document.querySelector('input[name="origenImport"]:checked');
    const origen = origenRadio ? origenRadio.value : 'NRE';

    importBtn.disabled = true;
    importBtn.innerText = 'Importando...';
    document.getElementById('importProgress').classList.remove('hidden');
    document.getElementById('importResults').classList.add('hidden');

    try {
        const formData = new FormData();
        formData.append('archivo', selectedFile);
        formData.append('origen', origen);

        const response = await fetch('/api/importar', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Error en la importación');
        }

        document.getElementById('importProgress').classList.add('hidden');
        document.getElementById('importResults').classList.remove('hidden');

        document.getElementById('resImportados').innerText = data.importados || 0;
        document.getElementById('resActualizados').innerText = data.actualizados || 0;
        document.getElementById('resErrores').innerText = data.errores || 0;

        // Show error details if any
        if (data.detalles && data.detalles.length > 0) {
            const detailsContainer = document.getElementById('importDetalles');
            if (detailsContainer) {
                detailsContainer.innerHTML = data.detalles.map(d => `<li>${d}</li>`).join('');
                detailsContainer.classList.remove('hidden');
            }
        }

        showToast(`Importación completada: ${data.importados} nuevos, ${data.actualizados} actualizados`, 'success');
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
        document.getElementById('importProgress').classList.add('hidden');
    } finally {
        importBtn.disabled = false;
        importBtn.innerText = '📥 Importar';
    }
}

// ─── Scraping de teléfonos ────────────────────────────────────────────────

const scrapeForm = document.getElementById('scrapeForm');
if (scrapeForm) {
    scrapeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const usuario = document.getElementById('scrapeUsuario').value;
    const password = document.getElementById('scrapePassword').value;

    if (!usuario || !password) {
        showToast('Ingresá usuario y contraseña', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerText = 'Buscando...';
    document.getElementById('scrapeProgress').classList.remove('hidden');
    document.getElementById('scrapeResults').classList.add('hidden');

    try {
        const response = await fetch('/api/scrape-telefonos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, password })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Error en la búsqueda');
        }

        document.getElementById('scrapeProgress').classList.add('hidden');
        document.getElementById('scrapeResults').classList.remove('hidden');

        document.getElementById('scrEncontrados').innerText = data.encontrados || 0;
        document.getElementById('scrNoEncontrados').innerText = data.no_encontrados || 0;

        // Show details
        const detailsContainer = document.getElementById('scrapeDetalles');
        if (detailsContainer && data.detalles) {
            detailsContainer.innerHTML = data.detalles.map(d => `<li>${d}</li>`).join('');
            detailsContainer.classList.remove('hidden');
        }

        showToast(`Búsqueda completada: ${data.encontrados} teléfonos encontrados`, 'success');
    } catch(err) {
        showToast('Error: ' + err.message, 'error');
        document.getElementById('scrapeProgress').classList.add('hidden');
    } finally {
        btn.disabled = false;
        btn.innerText = '🔍 Iniciar Búsqueda en Sistema';
    }
});
}

// ─── Importar Contactos VCF ───────────────────────────────────────────────

const vcfInput = document.getElementById('vcfInput');
if (vcfInput) {
    vcfInput.addEventListener('change', async (e) => {
        if (!e.target.files.length) return;
        
        const file = e.target.files[0];
        document.getElementById('vcfFileName').innerText = file.name;
        
        document.getElementById('vcfProgress').classList.remove('hidden');
        document.getElementById('vcfResults').classList.add('hidden');

        try {
            const formData = new FormData();
            formData.append('archivo', file);

            const response = await fetch('/api/importar-contactos', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error);

            document.getElementById('vcfProgress').classList.add('hidden');
            document.getElementById('vcfResults').classList.remove('hidden');
            document.getElementById('vcfImportados').innerText = data.importados || 0;
            document.getElementById('vcfCruzados').innerText = data.cruzados || 0;

            if (data.detalles && data.detalles.length > 0) {
                const det = document.getElementById('vcfDetalles');
                if (det) {
                    det.innerHTML = data.detalles.map(d => `<li>${d}</li>`).join('');
                    det.classList.remove('hidden');
                }
            }

            showToast(`${data.importados} contactos importados, ${data.cruzados} cruzados con clientes`, 'success');
        } catch (err) {
            showToast('Error: ' + err.message, 'error');
            document.getElementById('vcfProgress').classList.add('hidden');
        }
    });
}

// ─── Toast notifications ──────────────────────────────────────────────────

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}
