/**
 * cotizador_nre.js
 * Motor de Cotización Automática de Vehículos (NRE / Triunvirato)
 *
 * 🛡️ 4 CAPAS DE PROTECCIÓN IMPLEMENTADAS:
 * 1. Reutilización de Sesión (Session Pool / Keep-Alive): Mantiene cookies en memoria y evita logins repetitivos.
 * 2. Caché Local de 24hs (SQLite): Evita consultas duplicadas de los mismos vehículos en un día.
 * 3. Control de Concurrencia (Rate Limit / Semáforo): Máximo 2 consultas simultáneas a NRE.
 * 4. Fallback a Humano Elegante: Si NRE falla, da timeout o el vehículo es atípico, devuelve handoff comercial seguro.
 */

'use strict';

const cheerio = require('cheerio');
const db = require('./database');

const BASE_URL = process.env.SISTEMA_URL || 'http://149.50.137.101/emision';
const SISTEMA_USUARIO = process.env.SISTEMA_USUARIO || 'SUA';
const SISTEMA_PASSWORD = process.env.SISTEMA_PASSWORD || 'sua';
const TIMEOUT_MS = 8000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas de vida útil para la sesión en memoria

// ─── 1. CAPA DE PROTECCIÓN: POOL DE SESIÓN ─────────────────────────────────
let sessionCookies = [];
let sessionExpiresAt = 0;
let isAuthenticating = null;

function getCookieString() {
    return sessionCookies.join('; ');
}

function updateCookiesFromResponse(res) {
    const setCookieHeaders = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const rawCookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders].filter(Boolean);
    rawCookies.forEach(str => {
        if (str) {
            const parts = str.split(';');
            if (parts.length > 0) {
                const cookieKey = parts[0].split('=')[0].trim();
                sessionCookies = sessionCookies.filter(c => !c.startsWith(cookieKey + '='));
                sessionCookies.push(parts[0].trim());
            }
        }
    });
}

async function getOrInitSession(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && sessionCookies.length > 0 && now < sessionExpiresAt) {
        return getCookieString();
    }

    if (isAuthenticating) {
        return isAuthenticating;
    }

    isAuthenticating = (async () => {
        try {
            console.log('🔑 [Cotizador NRE] Autenticando sesión con NRE (SUA)...');
            const loginPageRes = await fetchWithTimeout(`${BASE_URL}/index.php`, {}, 4000);
            updateCookiesFromResponse(loginPageRes);

            const loginParams = new URLSearchParams();
            loginParams.append('useremi', SISTEMA_USUARIO);
            loginParams.append('pasemi', SISTEMA_PASSWORD);

            const loginRes = await fetchWithTimeout(`${BASE_URL}/emivali.php`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': getCookieString()
                },
                body: loginParams.toString()
            }, 5000);

            updateCookiesFromResponse(loginRes);
            sessionExpiresAt = Date.now() + SESSION_TTL_MS;
            console.log('✅ [Cotizador NRE] Sesión NRE establecida con éxito.');
            return getCookieString();
        } finally {
            isAuthenticating = null;
        }
    })();

    return isAuthenticating;
}

// ─── 3. CAPA DE PROTECCIÓN: RATE LIMITING & CONCURRENCIA ────────────────────
let activeRequests = 0;
const MAX_CONCURRENT = 2;
const requestQueue = [];

function acquireSemaphore() {
    return new Promise((resolve) => {
        if (activeRequests < MAX_CONCURRENT) {
            activeRequests++;
            resolve();
        } else {
            requestQueue.push(resolve);
        }
    });
}

function releaseSemaphore() {
    activeRequests--;
    if (requestQueue.length > 0) {
        const next = requestQueue.shift();
        activeRequests++;
        next();
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timeout);
    }
}

// ─── NORMALIZACIÓN Y HELPERS ────────────────────────────────────────────────
function normalizarTexto(str) {
    if (!str) return '';
    return String(str)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const ALIAS_MARCAS = {
    'VW': 'VOLKSWAGEN',
    'CHEVY': 'CHEVROLET',
    'MERCEDES': 'MERCEDES BENZ',
    'MERCEDES-BENZ': 'MERCEDES BENZ',
    'PEUGEOT': 'PEUGEOT',
    'CITROEN': 'CITROEN',
    'TOYOTA': 'TOYOTA',
    'FORD': 'FORD',
    'FIAT': 'FIAT',
    'RENAULT': 'RENAULT',
    'HONDA': 'HONDA',
    'NISSAN': 'NISSAN',
    'JEEP': 'JEEP',
    'HYUNDAI': 'HYUNDAI',
    'KIA': 'KIA',
    'BMW': 'BMW',
    'AUDI': 'AUDI'
};

function resolverMarcaAlias(marcaInput) {
    const norm = normalizarTexto(marcaInput);
    return ALIAS_MARCAS[norm] || norm;
}

function formatPesos(monto) {
    const num = Math.round(Number(monto) || 0);
    return '$ ' + num.toLocaleString('es-AR');
}

function parsePrecioNRE(precioStr) {
    if (!precioStr) return 0;
    let clean = String(precioStr).replace(/[\$\s]/g, '').trim();
    if (clean.includes(',') && clean.includes('.')) {
        // Formato '6,730.00' -> remover comas de miles
        clean = clean.replace(/,/g, '');
    } else if (clean.includes(',')) {
        const parts = clean.split(',');
        if (parts.length === 2 && parts[1].length === 2) {
            clean = parts[0] + '.' + parts[1];
        } else {
            clean = clean.replace(/,/g, '');
        }
    }
    return Math.round(parseFloat(clean) || 0);
}

// ─── 2. CAPA DE PROTECCIÓN: CACHÉ LOCAL (TTL 24hs) ──────────────────────────
function buscarEnCache(cacheKey) {
    try {
        const row = db.prepare(`
            SELECT resultado_json, created_at 
            FROM cotizaciones_cache 
            WHERE cache_key = ? 
              AND datetime(created_at, '+24 hours') > CURRENT_TIMESTAMP
            LIMIT 1
        `).get(cacheKey);

        if (row && row.resultado_json) {
            const data = JSON.parse(row.resultado_json);
            return {
                ...data,
                origen: 'cache_local',
                cached_at: row.created_at
            };
        }
    } catch (err) {
        console.error('⚠️ [Cotizador NRE] Error leyendo caché local:', err.message);
    }
    return null;
}

function guardarEnCache(cacheKey, marca, modelo, anio, codp, resultadoObj) {
    try {
        const jsonStr = JSON.stringify(resultadoObj);
        db.prepare(`
            INSERT INTO cotizaciones_cache (cache_key, marca, modelo, anio, codp, resultado_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                resultado_json = excluded.resultado_json,
                created_at = CURRENT_TIMESTAMP
        `).run(cacheKey, marca, modelo, parseInt(anio), String(codp), jsonStr);
    } catch (err) {
        console.error('⚠️ [Cotizador NRE] Error guardando en caché local:', err.message);
    }
}

// ─── 4. CAPA DE PROTECCIÓN: FALLBACK A HUMANO ───────────────────────────────
function armarRespuestaFallback(marca, modelo, anio, codp, motivo, detalle = '') {
    return {
        ok: true,
        fallback_humano: true,
        mensaje_cliente: '¡Perfecto! Ya le transferí los datos de tu vehículo a un asesor comercial para confirmarte la mejor cotización bonificada personalizada.',
        datos_vehiculo: {
            marca: marca || '',
            modelo: modelo || '',
            anio: anio || '',
            codp: codp || '7600'
        },
        motivo: motivo || 'requiere_evaluacion_comercial',
        detalle_tecnico: detalle || undefined,
        timestamp: new Date().toISOString()
    };
}

// ─── MOTOR DE COTIZACIÓN EN VIVO ────────────────────────────────────────────
async function cotizarEnNRE(marcaInput, modeloInput, anioInput, codpInput, usoInput = 1) {
    await acquireSemaphore();
    try {
        const marcaBuscada = resolverMarcaAlias(marcaInput);
        const anio = parseInt(anioInput, 10);
        const codp = String(codpInput || '7600').trim();
        const uso = parseInt(usoInput, 10) || 1; // 1 = Particular

        if (!anio || anio < 1980 || anio > new Date().getFullYear() + 1) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'anio_invalido');
        }

        const cookie = await getOrInitSession();

        // 1. Buscar marcas en sección Automotores (sec=4) con organizador Suárez (orga=7)
        const resMarcas = await fetchWithTimeout(`${BASE_URL}/buscomarca.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
            body: 'orga=7&sec=4'
        }, 5000);

        if (!resMarcas.ok) {
            await getOrInitSession(true);
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'reintento_sesion_nre');
        }

        const jsonMarcas = await resMarcas.json().catch(() => ({}));
        if (!jsonMarcas.salida) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'error_listado_marcas');
        }

        const $m = cheerio.load(jsonMarcas.salida);
        const marcasList = [];
        $m('option').each((i, opt) => {
            const val = $m(opt).attr('value');
            const text = $m(opt).text();
            const tag = $m(opt).attr('tag');
            if (val && val !== '0' && !text.includes('Seleccione')) {
                marcasList.push({ val, text, tag, norm: normalizarTexto(text) });
            }
        });

        // Match marca (Prioridad: 1. Coincidencia exacta, 2. Inicio de palabra / tokens, 3. Inclusión)
        let marcaObj = marcasList.find(m => m.norm === marcaBuscada);
        if (!marcaObj) {
            marcaObj = marcasList.find(m => m.norm.startsWith(marcaBuscada) || m.norm.split(' ').includes(marcaBuscada));
        }
        if (!marcaObj) {
            marcaObj = marcasList.find(m => m.norm.includes(marcaBuscada) || marcaBuscada.includes(m.norm));
        }

        if (!marcaObj) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'marca_no_encontrada');
        }

        // 2. Buscar modelos para el año
        const resModelos = await fetchWithTimeout(`${BASE_URL}/combo_mod.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
            body: `marca=${marcaObj.val}&anio=${anio}&sec=4`
        }, 5000);

        const jsonModelos = await resModelos.json().catch(() => ({}));
        if (!jsonModelos.salida) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'error_listado_modelos');
        }

        const $mod = cheerio.load(jsonModelos.salida);
        const modelosList = [];
        $mod('option').each((i, opt) => {
            const val = $mod(opt).attr('value');
            const text = $mod(opt).text();
            const tve = $mod(opt).attr('tve');
            const modin = $mod(opt).attr('modin');
            if (val && val !== '0' && !text.includes('Seleccione')) {
                modelosList.push({ val, text, tve, modin, norm: normalizarTexto(text) });
            }
        });

        if (modelosList.length === 0) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'sin_modelos_para_anio');
        }

        // Match modelo por palabras clave (prioriza modelos que contienen todos los términos de búsqueda)
        const modInputNorm = normalizarTexto(modeloInput);
        const tokens = modInputNorm.split(' ').filter(t => t.length >= 2);
        
        let modeloObj = null;
        let maxScore = -1;

        for (const m of modelosList) {
            let score = 0;
            const allTokensMatch = tokens.every(t => m.norm.includes(t));
            if (allTokensMatch && tokens.length > 0) {
                score += 100;
            }
            for (const t of tokens) {
                if (m.norm.includes(t)) score += t.length * 10;
            }
            if (m.norm === modInputNorm) {
                score += 500;
            }
            if (score > maxScore) {
                maxScore = score;
                modeloObj = m;
            }
        }

        if (!modeloObj || maxScore === 0) {
            modeloObj = modelosList[0];
        }

        // 3. Obtener valor y suma asegurada InfoAuto (veovalor.php)
        const infomar = ('00' + (marcaObj.tag || '0')).slice(-3);
        const infomod = ('000' + (modeloObj.modin || '0')).slice(-4);
        const infoauto = infomar + infomod;

        const resValor = await fetchWithTimeout(`${BASE_URL}/veovalor.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
            body: `anio=${anio}&modelo=${modeloObj.val}&okm=0&info=${infoauto}&codp=${codp}&tipvesc=${modeloObj.tve || 1}&orgesc=7&orgtpc=0&sec=4`
        }, 5000);

        const jsonValor = await resValor.json().catch(() => ({}));
        const sumaAsegurada = Math.round(Number(jsonValor.valor) || 0);

        // 4. Cotizar planes y cuotas en vivo (emimuestro.php)
        const today = new Date();
        const dStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
        const hDate = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
        const hStr = `${String(hDate.getDate()).padStart(2, '0')}/${String(hDate.getMonth() + 1).padStart(2, '0')}/${hDate.getFullYear()}`;

        const queryParams = new URLSearchParams({
            orga: '7',
            marca: String(marcaObj.val),
            anio: String(anio),
            modelo: String(modeloObj.val),
            sec: '4',
            suma: String(sumaAsegurada),
            desc: `${marcaObj.text} ${modeloObj.text}`.trim(),
            iibb: '0',
            ajuste: '2',
            prov: '1',
            sitiva: '1',
            usoesc: String(uso),
            usotpc: '0',
            acc: '0', vaacc: '0',
            acc2: '0', vaacc2: '0',
            acc3: '0', vaacc3: '0',
            acc4: '0', vaacc4: '0',
            idauto: String(modeloObj.val),
            okm: '0',
            duso: uso === 2 ? 'App / Comercial' : 'Particular',
            sumat: '0',
            rast: '0',
            vdes: dStr,
            vhas: hStr,
            codp: codp,
            orgatpc: '0',
            info: infoauto,
            idauttpc: '0',
            dto: '0',
            organ: 'SUAREZ LISANDRO',
            dtotar: '0',
            compa: '3'
        });

        const resMuestro = await fetchWithTimeout(`${BASE_URL}/emimuestro.php?${queryParams.toString()}`, {
            headers: { 'Cookie': cookie }
        }, 6000);

        const htmlMuestro = await resMuestro.text();
        const $muestro = cheerio.load(htmlMuestro);

        const rawText = $muestro.text();
        if (!rawText.includes('Costo mensual')) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'nre_sin_planes_disponibles');
        }

        // Parsea planes y cuotas desde el contenido de emimuestro.php
        const planes = [];
        const regexPlan = /Cobertura:\s*([A-Za-z0-9\s]+?)\s*(?:Suma:\s*\$\s*[\d.,]+|Sin Suma)?\s*Costo mensual\s*:\s*\$\s*([\d.,]+)/gi;
        let match;

        while ((match = regexPlan.exec(rawText)) !== null) {
            const rawNombre = match[1].trim();
            const cuotaNum = parsePrecioNRE(match[2]);

            let codigo = 'OTRO';
            let descripcion = 'Cobertura aseguradora Triunvirato';
            let nombreLimpio = rawNombre;

            if (/^A\b/i.test(rawNombre)) {
                codigo = 'A';
                nombreLimpio = 'Responsabilidad Civil';
                descripcion = 'Cobertura legal obligatoria ante terceros transportados y no transportados.';
            } else if (/^B1\b/i.test(rawNombre)) {
                codigo = 'B1';
                nombreLimpio = 'Robo e Incendio Total';
                descripcion = 'Resp. Civil + Pérdida Total por Robo, Hurto e Incendio.';
            } else if (/^B\b/i.test(rawNombre)) {
                codigo = 'B';
                nombreLimpio = 'Destrucción Total y Robo Total';
                descripcion = 'Resp. Civil + Destrucción Total por Accidente + Robo/Incendio Total.';
            } else if (/^C1\b/i.test(rawNombre)) {
                codigo = 'C1';
                nombreLimpio = 'Terceros Completo Básico';
                descripcion = 'Resp. Civil + Robo e Incendio Total y Parcial + Destrucción Total.';
            } else if (/^C\s*Full/i.test(rawNombre)) {
                codigo = 'C_FULL';
                nombreLimpio = 'Terceros Completo Full (Granizo)';
                descripcion = 'Terceros Completo + Cristales, Cerraduras y Granizo sin franquicia.';
            } else if (/^C\s*Plus/i.test(rawNombre)) {
                codigo = 'C_PLUS';
                nombreLimpio = 'Terceros Completo Plus';
                descripcion = 'Terceros Completo con ampliación de límites de cristales y cerraduras.';
            } else if (/^C\b/i.test(rawNombre)) {
                codigo = 'C';
                nombreLimpio = 'Terceros Completo Clásico';
                descripcion = 'Resp. Civil + Robo/Incendio Total y Parcial + Cristales laterales.';
            }

            if (cuotaNum > 0 && !planes.some(p => p.codigo === codigo)) {
                planes.push({
                    codigo,
                    nombre: nombreLimpio,
                    descripcion,
                    cuota_mensual: cuotaNum,
                    cuota_formato: formatPesos(cuotaNum)
                });
            }
        }

        if (planes.length === 0) {
            return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codp, 'parseo_planes_vacio');
        }

        planes.sort((a, b) => a.cuota_mensual - b.cuota_mensual);

        return {
            ok: true,
            fallback_humano: false,
            vehiculo: {
                marca: marcaObj.text.trim(),
                modelo: modeloObj.text.trim(),
                anio: anio,
                codp: codp,
                localidad: codp === '7600' ? 'Mar del Plata' : (codp === '1900' ? 'La Plata' : 'Buenos Aires / Interior'),
                suma_asegurada: sumaAsegurada,
                suma_asegurada_formato: formatPesos(sumaAsegurada)
            },
            planes,
            origen: 'nre_live',
            timestamp: new Date().toISOString()
        };

    } catch (err) {
        console.error('❌ [Cotizador NRE] Error en cotizarEnNRE:', err.message);
        return armarRespuestaFallback(marcaInput, modeloInput, anioInput, codpInput, 'error_excepcion_nre', err.message);
    } finally {
        releaseSemaphore();
    }
}

/**
 * Función Principal para el Endpoint /api/cotizador/vehiculo
 * Aplica primero la capa de caché y luego la cotización en vivo con fallback.
 */
async function cotizarVehiculo({ marca, modelo, anio, codp = '7600', uso = 1 }) {
    if (!marca || !modelo || !anio) {
        return {
            ok: false,
            error: 'Faltan parámetros obligatorios: marca, modelo y año son requeridos.'
        };
    }

    const normMarca = normalizarTexto(marca);
    const normModelo = normalizarTexto(modelo);
    const anioNum = parseInt(anio, 10);
    const codpStr = String(codp).trim();
    const cacheKey = `${normMarca}_${normModelo}_${anioNum}_${codpStr}_${uso}`;

    // 1. Revisar Caché Local (TTL 24hs)
    const cached = buscarEnCache(cacheKey);
    if (cached) {
        return cached;
    }

    // 2. Cotizar en vivo en NRE con semáforo y timeout
    const resultado = await cotizarEnNRE(marca, modelo, anio, codp, uso);

    // 3. Si fue exitoso (no fallback), guardar en caché 24hs
    if (resultado.ok && !resultado.fallback_humano && resultado.planes && resultado.planes.length > 0) {
        guardarEnCache(cacheKey, normMarca, normModelo, anioNum, codpStr, resultado);
    }

    return resultado;
}

module.exports = {
    cotizarVehiculo,
    cotizarEnNRE,
    resolverMarcaAlias,
    buscarEnCache,
    guardarEnCache,
    getOrInitSession
};
