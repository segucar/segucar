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

/**
 * Normaliza una fecha a medianoche local (sin horas) para comparaciones correctas.
 */
function _normalizarFecha(fecha) {
    if (!fecha) return new Date(NaN);
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return d;
    d.setHours(0, 0, 0, 0);
    return d;
}

function toLocalDateString(fecha) {
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * Verifica si una fecha es Sábado, Domingo o Feriado en Argentina.
 * @param {Date} fecha
 * @returns {boolean}
 */
function esNoHabil(fecha) {
    const d = _normalizarFecha(fecha);
    if (isNaN(d.getTime())) return false;
    const diaSemana = d.getDay(); // 0 = Domingo, 6 = Sábado
    if (diaSemana === 0 || diaSemana === 6) return true;

    const fechaStr = toLocalDateString(d);
    if (!fechaStr) return false;
    const anio = d.getFullYear();
    const feriados = _getFeriadosDelAnio(anio);
    return feriados.has(fechaStr);
}

/**
 * Verifica si una fecha es día hábil (Lunes–Viernes, no feriado).
 * @param {Date} fecha
 * @returns {boolean}
 */
function esHabil(fecha) {
    return !esNoHabil(fecha);
}

/**
 * Si la fecha cae en finde o feriado, la traslada al PRIMER DÍA HÁBIL SIGUIENTE.
 * @param {Date} fecha
 * @returns {Date}
 */
function obtenerSiguienteDiaHabil(fecha) {
    let f = _normalizarFecha(fecha);
    if (isNaN(f.getTime())) return new Date();
    let maxSafety = 30;
    while (esNoHabil(f) && maxSafety-- > 0) {
        f = new Date(f);
        f.setDate(f.getDate() + 1);
    }
    return f;
}

/**
 * Retrocede hasta el ÚLTIMO DÍA HÁBIL ANTERIOR (si el actual es no hábil).
 * @param {Date} fecha
 * @returns {Date}
 */
function obtenerAnteriorDiaHabil(fecha) {
    let f = _normalizarFecha(fecha);
    if (isNaN(f.getTime())) return new Date();
    let maxSafety = 30;
    while (esNoHabil(f) && maxSafety-- > 0) {
        f = new Date(f);
        f.setDate(f.getDate() - 1);
    }
    return f;
}

/**
 * Cuenta días hábiles entre dos fechas (excluyendo fecha inicio, incluyendo fecha fin).
 * @param {Date} desde
 * @param {Date} hasta
 * @returns {number} días hábiles (positivo si hasta > desde, negativo si hasta < desde)
 */
function diasHabilesEntre(desde, hasta) {
    const d = _normalizarFecha(desde);
    const h = _normalizarFecha(hasta);
    if (isNaN(d.getTime()) || isNaN(h.getTime())) return 0;
    const avanzar = h >= d ? 1 : -1;
    let actual = new Date(d);
    actual.setDate(actual.getDate() + avanzar);
    let contador = 0;
    let maxSafety = 365;
    while (toLocalDateString(actual) !== toLocalDateString(h) && maxSafety-- > 0) {
        if (esHabil(actual)) contador += avanzar;
        actual = new Date(actual);
        actual.setDate(actual.getDate() + avanzar);
    }
    if (esHabil(h)) contador += avanzar;
    return contador;
}

/**
 * Evalúa el estado de cobranza de una cuota considerando días hábiles.
 *
 * Lógica:
 *  - Si HOY no es hábil → AL_DIA (no se notifica)
 *  - Calcula la "fecha efectiva de vencimiento" (primer día hábil desde el vencimiento nominal)
 *  - Calcula calDiff en días hábiles entre hoy y el vencimiento efectivo
 *  - Aplica los mismos umbrales que el sistema actual pero en días hábiles
 *
 * Estados devueltos (alineados con ESTADOS del stateManager):
 *  'recordatorio_48hs'     → vence en 2 días hábiles
 *  'cuota_vencida_0_48hs'  → venció hace 2 días hábiles
 *  'cuota_vencida_48_96hs' → venció hace 4 días hábiles
 *  'mora_critica'          → venció hace más de 4 días hábiles
 *  'al_dia'                → cualquier otro caso
 *
 * @param {string|Date} fechaVencimiento - Fecha de vencimiento nominal de la cuota
 * @param {number} saldoPendiente - Monto con saldo impago (0 = al día)
 * @param {Date} [fechaHoy=new Date()] - Fecha de referencia (por defecto hoy)
 * @returns {string} estado
 */
function evaluarEstadoCobranzaHabil(fechaVencimiento, saldoPendiente, fechaHoy = new Date()) {
    if (!fechaVencimiento || parseFloat(saldoPendiente || 0) <= 0) return 'al_dia';

    const hoy = _normalizarFecha(fechaHoy);

    // Si hoy no es hábil → no se notifica nada
    if (esNoHabil(hoy)) return 'al_dia';

    // Fecha efectiva: primer día hábil desde el vencimiento nominal
    const vtoNominal = _normalizarFecha(new Date(String(fechaVencimiento).includes('-') ? fechaVencimiento : fechaVencimiento));
    const vtoEfectivo = obtenerSiguienteDiaHabil(vtoNominal);

    const calDiffHabil = diasHabilesEntre(hoy, vtoEfectivo);
    // calDiffHabil > 0 → vence en el futuro
    // calDiffHabil < 0 → ya venció
    // calDiffHabil === 0 → vence hoy

    if (calDiffHabil === 2)  return 'recordatorio_48hs';      // 🟡 Vence en 2 días hábiles
    if (calDiffHabil === -2) return 'cuota_vencida_0_48hs';   // 🟠 Venció hace 2 días hábiles
    if (calDiffHabil === -4) return 'cuota_vencida_48_96hs';  // 🔴 Venció hace 4 días hábiles
    if (calDiffHabil < -4)  return 'mora_critica';            // 🚨 Mora Crítica

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
    esNoHabil,
    esHabil,
    obtenerSiguienteDiaHabil,
    obtenerAnteriorDiaHabil,
    diasHabilesEntre,
    evaluarEstadoCobranzaHabil,
    obtenerCuotasParaNotificarHoy,
    toLocalDateString,
};
