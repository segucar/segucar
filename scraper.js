const cheerio = require('cheerio');
const db = require('./database');

function sanitizeAndFixPhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/[^\d]/g, '');
    if (cleaned.length === 0) return '';

    if (cleaned.startsWith('549') && cleaned.length >= 13) {
        cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('54') && cleaned.length >= 12) {
        cleaned = cleaned.substring(2);
    }

    if (cleaned.startsWith('0') && cleaned.length >= 11) {
        cleaned = cleaned.substring(1);
    }

    if (cleaned.startsWith('22315') && cleaned.length >= 12) {
        cleaned = '223' + cleaned.substring(5);
    }

    // VALIDACIÓN ESTRICTA: exactamente 10 dígitos
    if (cleaned.length === 10) {
        return '549' + cleaned;
    }
    if (cleaned.length === 13 && cleaned.startsWith('549')) {
        return cleaned;
    }
    // NO inventar — retornar vacío si no es válido
    return '';
}

function isOfficeHours() {
    const now = new Date();
    const argTimeStr = now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' });
    const argDate = new Date(argTimeStr);

    const day = argDate.getDay(); // 0 = Dom, 1 = Lun, ..., 6 = Sáb
    const hours = argDate.getHours();
    const minutes = argDate.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    // Lun (1) a Vie (5): 09:00 (540m) a 16:00 (960m)
    if (day >= 1 && day <= 5) {
        return timeInMinutes >= 540 && timeInMinutes <= 960;
    }
    // Sáb (6): 10:00 (600m) a 13:00 (780m)
    if (day === 6) {
        return timeInMinutes >= 600 && timeInMinutes <= 780;
    }
    // Dom (0): Cerrado
    return false;
}

async function scrapeTelefonos(usuario, password, onProgress = () => {}, bypassHorario = false) {
    let encontrados = 0;
    let no_encontrados = 0;
    let errores = 0;
    let detalles = [];

    if (!bypassHorario && !isOfficeHours()) {
        onProgress({ status: '⏰ Fuera de horario laboral (Lun-Vie 9-16h, Sáb 10-13h). Búsqueda pausada.' });
        return { encontrados: 0, no_encontrados: 0, errores: 0, detalles: ['Fuera de horario laboral de la oficina.'] };
    }

    const baseUrl = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
    
    // Cookie management
    let cookies = [];
    const getCookieString = () => cookies.join('; ');
    const updateCookies = (response) => {
        const setCookieHeaders = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
        const rawCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
        rawCookies.forEach(cookieStr => {
            if(cookieStr) {
                const parts = cookieStr.split(';');
                if(parts.length > 0) cookies.push(parts[0]);
            }
        });
    };

    try {
        onProgress({ status: 'Obteniendo página de login...' });

        // 1. GET login page to get cookies and detect form fields
        const loginPageRes = await fetch(`${baseUrl}/index.php`);
        updateCookies(loginPageRes);
        const loginPageText = await loginPageRes.text();
        const $login = cheerio.load(loginPageText);
        
        // Auto-detect form field names from the HTML
        let userField = 'useremi';  // known field from the actual system
        let passField = 'pasemi';   // known field from the actual system
        
        // Override with what we find in the form (for robustness)
        $login('input[type="text"]').each((i, el) => { 
            if($login(el).attr('name')) userField = $login(el).attr('name'); 
        });
        $login('input[type="password"]').each((i, el) => { 
            if($login(el).attr('name')) passField = $login(el).attr('name'); 
        });

        // Detect form action (known: emivali.php)
        const formAction = $login('form').attr('action') || 'emivali.php';
        const loginUrl = formAction.startsWith('http') ? formAction : `${baseUrl}/${formAction.replace(/^\//, '')}`;

        onProgress({ status: `Iniciando sesión con campos ${userField}/${passField}...` });

        // 2. POST login
        const loginParams = new URLSearchParams();
        loginParams.append(userField, usuario);
        loginParams.append(passField, password);

        const loginRes = await fetch(loginUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': getCookieString()
            },
            body: loginParams.toString(),
            redirect: 'manual'
        });
        updateCookies(loginRes);

        // The system responds with a JS redirect: window.location="emicoti.php"
        // Follow any redirect
        const loginBody = await loginRes.text();
        if (loginRes.status === 302 || loginRes.status === 301) {
            const location = loginRes.headers.get('location');
            if (location) {
                const followUrl = location.startsWith('http') ? location : `${baseUrl}/${location.replace(/^\//, '')}`;
                const followRes = await fetch(followUrl, {
                    headers: { 'Cookie': getCookieString() }
                });
                updateCookies(followRes);
            }
        } else if (loginBody.includes('window.location')) {
            // JS redirect — follow it
            const match = loginBody.match(/window\.location\s*=\s*"([^"]+)"/);
            if (match) {
                const redirectUrl = `${baseUrl}/${match[1]}`;
                const followRes = await fetch(redirectUrl, {
                    headers: { 'Cookie': getCookieString() }
                });
                updateCookies(followRes);
            }
        }

        // 3. Verify session
        const checkRes = await fetch(`${baseUrl}/consulta-polizas.php`, {
            headers: { 'Cookie': getCookieString() },
            redirect: 'manual'
        });
        updateCookies(checkRes);
        
        const checkBody = await checkRes.text();
        if (checkRes.status === 302 || checkBody.includes('window.location="index.php"')) {
            return { encontrados: 0, no_encontrados: 0, errores: 1, 
                     detalles: ['Error: Login fallido. Verificá usuario y contraseña.'] };
        }

        onProgress({ status: '✅ Login exitoso.' });

        // 4. Get all polizas where client has no phone
        const rows = db.prepare(`
            SELECT p.operacion, c.id as cliente_id, c.nombre 
            FROM polizas p 
            JOIN clientes c ON p.cliente_id = c.id 
            WHERE c.telefono IS NULL OR c.telefono = ''
        `).all();

        onProgress({ status: `Se encontraron ${rows.length} pólizas sin teléfono.` });

        if (rows.length === 0) {
            return { encontrados: 0, no_encontrados: 0, errores: 0,
                     detalles: ['No hay clientes sin teléfono en la base de datos.'] };
        }

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            onProgress({ status: `Analizando póliza ${row.operacion} (${i + 1}/${rows.length})...` });

            try {
                const detailRes = await fetch(`${baseUrl}/muestro-polizas.php?prop=${row.operacion}`, {
                    headers: { 'Cookie': getCookieString() }
                });
                
                const detailText = await detailRes.text();
                const $ = cheerio.load(detailText);
                
                // ─── Parse the page structure ──────────────────────────────────
                // The system uses Bootstrap grid: <div class="col-md-2">Label</div>
                // followed by <div class="col-md-4"><strong>Value</strong></div>
                
                let observaciones = '';
                let nombreAseg = '';
                let direccion = '';
                
                // Extract all label-value pairs from the page
                $('div[class*="col-md"]').each((idx, el) => {
                    const text = $(el).text().trim();
                    const textLower = text.toLowerCase();
                    
                    // Check for "Observaciones" label
                    if (textLower === 'observaciones' || textLower.includes('observacion')) {
                        // Get all following sibling divs until next label-like div
                        const siblings = $(el).nextAll('div');
                        siblings.each((sidx, sib) => {
                            const sibText = $(sib).text().trim();
                            if (sibText && sidx < 3) {
                                observaciones += ' ' + sibText;
                            }
                        });
                    }
                    
                    // Also extract name if we don't have it
                    if (textLower === 'aseg.:' || textLower === 'aseg:' || textLower.startsWith('aseg')) {
                        const next = $(el).next('div');
                        if (next.length) {
                            nombreAseg = next.find('strong').text().trim() || next.text().trim();
                        }
                    }
                    
                    // Extract address
                    if (textLower === 'dirección:' || textLower.startsWith('direcc')) {
                        const next = $(el).next('div');
                        if (next.length) {
                            direccion = next.find('strong').text().trim() || next.text().trim();
                        }
                    }
                });

                // Also search the full page text for phone patterns
                const fullText = $('body').text();
                const allText = observaciones + ' ' + fullText;

                // ─── Extract phone number ──────────────────────────────────────
                let foundPhone = null;
                const phonePatterns = [
                    /\+?54\s*9?\s*223\s*\d{7}/,
                    /0?223\s*15\s*\d{6,7}/,
                    /223[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d/,
                    /15[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d/,
                ];

                // Try observaciones first
                for (let r of phonePatterns) {
                    const matches = observaciones.match(new RegExp(r.source, 'g'));
                    if (matches) {
                        foundPhone = matches.find(m => m.includes('223')) || matches[0];
                        foundPhone = foundPhone.replace(/[\s\-\(\)]/g, '');
                        break;
                    }
                }

                if (foundPhone) {
                    const sanitized = sanitizeAndFixPhone(foundPhone);
                    if (sanitized) {
                        db.prepare('UPDATE clientes SET telefono = ? WHERE id = ?').run(sanitized, row.cliente_id);
                        if (typeof db.guardarTelefonoMaestro === 'function') {
                            db.guardarTelefonoMaestro(row.cliente_id, row.nombre, sanitized, 'scraper');
                        }
                    }
                    
                    // Also update name and address if available and missing
                    if (nombreAseg) {
                        db.prepare("UPDATE clientes SET nombre = COALESCE(NULLIF(nombre, ''), ?) WHERE id = ?").run(nombreAseg, row.cliente_id);
                    }
                    if (direccion) {
                        db.prepare("UPDATE clientes SET direccion = COALESCE(NULLIF(direccion, ''), ?) WHERE id = ?").run(direccion, row.cliente_id);
                    }
                    
                    encontrados++;
                    detalles.push(`✅ Op ${row.operacion}: teléfono ${foundPhone}` + 
                                 (nombreAseg ? ` (${nombreAseg})` : ''));
                } else {
                    no_encontrados++;
                    detalles.push(`❌ Op ${row.operacion}: sin teléfono` + 
                                 (observaciones.trim() ? ` | Obs: "${observaciones.trim().substring(0, 80)}"` : ' | Sin observaciones'));
                }
            } catch (err) {
                errores++;
                detalles.push(`⚠️ Error op ${row.operacion}: ${err.message}`);
            }

            // Sleep 1-2s between requests
            const sleepTime = 1000 + Math.random() * 1000;
            await new Promise(res => setTimeout(res, sleepTime));
        }
    } catch (err) {
        errores++;
        detalles.push(`Error general: ${err.message}`);
    }

    onProgress({ status: 'Extracción finalizada.' });
    return { encontrados, no_encontrados, errores, detalles };
}

async function consultarPolizaSistema(operacion, usuario, password) {
    const baseUrl = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
    let cookies = [];
    const getCookieString = () => cookies.join('; ');
    const updateCookies = (res) => {
        const setCookieHeaders = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        const rawCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
        rawCookies.forEach(str => {
            if (str) {
                const parts = str.split(';');
                if (parts.length > 0) cookies.push(parts[0]);
            }
        });
    };

    try {
        const loginPageRes = await fetch(`${baseUrl}/index.php`);
        updateCookies(loginPageRes);
        
        const loginParams = new URLSearchParams();
        loginParams.append('useremi', usuario);
        loginParams.append('pasemi', password);

        const loginRes = await fetch(`${baseUrl}/emivali.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': getCookieString()
            },
            body: loginParams.toString(),
            redirect: 'manual'
        });
        updateCookies(loginRes);

        const detailRes = await fetch(`${baseUrl}/muestro-polizas.php?prop=${operacion}`, {
            headers: { 'Cookie': getCookieString() }
        });
        const detailText = await detailRes.text();
        const $ = cheerio.load(detailText);

        let observaciones = '';
        let nombreAseg = '';
        let direccion = '';

        $('div[class*="col-md"]').each((idx, el) => {
            const text = $(el).text().trim().toLowerCase();
            if (text.includes('observacion')) {
                $(el).nextAll('div').each((sidx, sib) => {
                    if (sidx < 3) observaciones += ' ' + $(sib).text().trim();
                });
            }
            if (text.startsWith('aseg')) {
                const next = $(el).next('div');
                if (next.length) nombreAseg = next.find('strong').text().trim() || next.text().trim();
            }
            if (text.startsWith('direcc')) {
                const next = $(el).next('div');
                if (next.length) direccion = next.find('strong').text().trim() || next.text().trim();
            }
        });

        let foundPhone = null;
        const phonePatterns = [
            /\+?54\s*9?\s*223\s*\d{7}/,
            /0?223\s*15\s*\d{6,7}/,
            /223[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d/,
            /15[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d[\s\-]*\d/,
        ];
        for (let r of phonePatterns) {
            const matches = observaciones.match(new RegExp(r.source, 'g'));
            if (matches) {
                foundPhone = matches.find(m => m.includes('223')) || matches[0];
                foundPhone = foundPhone.replace(/[\s\-\(\)]/g, '');
                break;
            }
        }

        return { operacion, nombre: nombreAseg, direccion, telefono: foundPhone, observaciones: observaciones.trim() };
    } catch (e) {
        return { operacion, error: e.message };
    }
}

module.exports = { scrapeTelefonos, consultarPolizaSistema };
