/**
 * holidays_ar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilidades de días hábiles para Argentina usando date-holidays.
 * Compatible con CommonJS (require). Exporta las funciones para usar en
 * server.js, stateManager.js (Node) y cualquier módulo del proyecto.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const HolidaysLib = require('date-holidays');
const Holidays = HolidaysLib.default || HolidaysLib;
const hd = new Holidays('AR');

// ─── Cache de feriados por año para no recalcular ─────────────────────────
const _cacheHolidays = {};

function _getFeriadosDelAnio(anio) {
    if (!_cacheHolidays[anio]) {
        // Convertimos a Set de strings 'YYYY-MM-DD' para búsqueda O(1)
        _cacheHolidays[anio] = new Set(
            hd.getHolidays(anio).map(h => h.date.slice(0, 10))
        );
    }
    return _cacheHolidays[anio];
}

function getArgentinaNow() {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
    return formatter.format(new Date());
}

/**
 * Normaliza una fecha a medianoche UTC para comparaciones puras de calendario sin desfasajes horarios.
 */
function _normalizarFecha(fecha) {
    if (!fecha) return new Date(NaN);
    if (typeof fecha === 'string') {
        const str = fecha.trim().slice(0, 10);
        const parts = str.split('-');
        if (parts.length === 3) {
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10) - 1;
            const day = parseInt(parts[2], 10);
            if (!isNaN(y) && !isNaN(m) && !isNaN(day)) {
                return new Date(Date.UTC(y, m, day, 0, 0, 0, 0));
            }
        }
    }
    if (fecha instanceof Date) {
        if (isNaN(fecha.getTime())) return new Date(NaN);
        return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate(), 0, 0, 0, 0));
    }
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return d;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function toLocalDateString(fecha) {
    const d = _normalizarFecha(fecha);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Verifica si una fecha es Domingo o Feriado en Argentina.
 * NOTA: SEGUCar trabaja los SÁBADOS — solo se pausa los Domingos y Feriados.
 * @param {Date|string} fecha
 * @returns {boolean}
 */
function esNoHabil(fecha) {
    const d = _normalizarFecha(fecha);
    if (isNaN(d.getTime())) return false;
    const diaSemana = d.getUTCDay(); // 0 = Domingo, 6 = Sábado
    // Solo Domingo es no hábil (SEGUCar trabaja los sábados)
    if (diaSemana === 0) return true;

    const fechaStr = toLocalDateString(d);
    if (!fechaStr) return false;
    const anio = d.getUTCFullYear();
    const feriados = _getFeriadosDelAnio(anio);
    return feriados.has(fechaStr);
}

/**
 * Verifica si una fecha es día hábil.
 * @param {Date|string} fecha
 * @returns {boolean}
 */
function esHabil(fecha) {
    return !esNoHabil(fecha);
}

/**
 * Si la fecha cae en finde o feriado, la traslada al PRIMER DÍA HÁBIL SIGUIENTE.
 * @param {Date|string} fecha
 * @returns {Date}
 */
function obtenerSiguienteDiaHabil(fecha) {
    let f = _normalizarFecha(fecha);
    if (isNaN(f.getTime())) return new Date();
    let maxSafety = 30;
    while (esNoHabil(f) && maxSafety-- > 0) {
        f = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate() + 1, 0, 0, 0, 0));
    }
    return f;
}

/**
 * Retrocede hasta el ÚLTIMO DÍA HÁBIL ANTERIOR (si el actual es no hábil).
 * @param {Date|string} fecha
 * @returns {Date}
 */
function obtenerAnteriorDiaHabil(fecha) {
    let f = _normalizarFecha(fecha);
    if (isNaN(f.getTime())) return new Date();
    let maxSafety = 30;
    while (esNoHabil(f) && maxSafety-- > 0) {
        f = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate() - 1, 0, 0, 0, 0));
    }
    return f;
}

/**
 * Cuenta días hábiles entre dos fechas (excluyendo fecha inicio, incluyendo fecha fin).
 * @param {Date|string} desde
 * @param {Date|string} hasta
 * @returns {number} días hábiles
 */
function diasHabilesEntre(desde, hasta) {
    const d = _normalizarFecha(desde);
    const h = _normalizarFecha(hasta);
    if (isNaN(d.getTime()) || isNaN(h.getTime())) return 0;
    const avanzar = h >= d ? 1 : -1;
    let actual = new Date(d);
    actual = new Date(Date.UTC(actual.getUTCFullYear(), actual.getUTCMonth(), actual.getUTCDate() + avanzar, 0, 0, 0, 0));
    let contador = 0;
    let maxSafety = 365;
    while (toLocalDateString(actual) !== toLocalDateString(h) && maxSafety-- > 0) {
        if (esHabil(actual)) contador += avanzar;
        actual = new Date(Date.UTC(actual.getUTCFullYear(), actual.getUTCMonth(), actual.getUTCDate() + avanzar, 0, 0, 0, 0));
    }
    if (esHabil(h)) contador += avanzar;
    return contador;
}

/**
 * Evalúa el estado de cobranza de una cuota considerando días hábiles y feriados.
 *
 * @param {string|Date} fechaVencimiento - Fecha de vencimiento nominal de la cuota
 * @param {number} saldoPendiente - Monto con saldo impago (0 = al día)
 * @param {string|Date} [fechaHoy=getArgentinaNow()] - Fecha de referencia (por defecto hoy Argentina)
 * @returns {string} estado
 */
function evaluarEstadoCobranzaHabil(fechaVencimiento, saldoPendiente, fechaHoy = getArgentinaNow()) {
    if (!fechaVencimiento || parseFloat(saldoPendiente || 0) <= 0) return 'al_dia';

    const hoy = _normalizarFecha(fechaHoy);

    // Si hoy no es hábil → no se notifica nada
    if (esNoHabil(hoy)) return 'al_dia';

    const vtoNominal = _normalizarFecha(fechaVencimiento);

    // Días calendario respecto al vencimiento nominal impreso en la póliza
    const calDiff = Math.round((vtoNominal - hoy) / (1000 * 60 * 60 * 24));
    const diaSemana = hoy.getUTCDay(); // 0=Dom, 1=Lun, 5=Vie, 6=Sáb

    // ── RECORDATORIO PREVENTIVO: vence en EXACTAMENTE 2 días calendario (48 hs exactas) ──────
    // 🟡 Miércoles -> cuotas del Viernes (calDiff = 2)
    // 🟡 Jueves    -> cuotas del Sábado (calDiff = 2)
    // 🟡 Viernes   -> cuotas del Domingo (calDiff = 2)
    // 🟡 Sábado    -> cuotas del Lunes (calDiff = 2)
    if (calDiff === 2) return 'recordatorio_48hs';

    // ── PRIMER AVISO (48 hs): venció hace EXACTAMENTE 2 días ───────
    if (calDiff === -2) return 'cuota_vencida_0_48hs';
    if (diaSemana === 1 && (calDiff === -3 || calDiff === -4)) return 'cuota_vencida_0_48hs';

    // ── SEGUNDO AVISO (96 hs): venció hace EXACTAMENTE 4 días ──────
    if (calDiff === -4) return 'cuota_vencida_48_96hs';

    // ── MORA CRÍTICA: venció hace más de 4 días ────────────────────────────────
    if (calDiff < -4) return 'mora_critica';

    return 'al_dia';
}


/**
 * Filtra una lista de cuotas y devuelve solo las que corresponde notificar HOY.
 * @param {Array} cuotas - Array de objetos con al menos { fechaVencimiento, saldoPendiente }
 * @param {Date} [fechaHoy=new Date()]
 * @returns {Array} cuotas con su 'estadoHabil' añadido
 */
function obtenerCuotasParaNotificarHoy(cuotas, fechaHoy = new Date()) {
    const hoy = _normalizarFecha(fechaHoy);

    // Si hoy es finde o feriado → no se envía nada
    if (esNoHabil(hoy)) return [];

    const ESTADOS_NOTIFICABLES = new Set([
        'recordatorio_48hs',
        'cuota_vencida_0_48hs',
        'cuota_vencida_48_96hs',
        'mora_critica'
    ]);

    return cuotas
        .map(cuota => ({
            ...cuota,
            estadoHabil: evaluarEstadoCobranzaHabil(cuota.fechaVencimiento, cuota.saldoPendiente, hoy)
        }))
        .filter(cuota => ESTADOS_NOTIFICABLES.has(cuota.estadoHabil));
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    getArgentinaNow,
    esNoHabil,
    esHabil,
    obtenerSiguienteDiaHabil,
    obtenerAnteriorDiaHabil,
    diasHabilesEntre,
    evaluarEstadoCobranzaHabil,
    obtenerCuotasParaNotificarHoy,
    toLocalDateString,
};
