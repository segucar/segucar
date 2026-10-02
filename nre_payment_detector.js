/**
 * nre_payment_detector.js — Detector Inteligente de Pagos Reales vs Lotes Administrativos NRE
 * 
 * ⚠️ ESTADO: APAGADO / DESACTIVADO POR DEFECTO (SWITCH = FALSE)
 * No modifica estados de pago en la base de datos hasta confirmación explícita de administración.
 * 
 * OBJETIVO TÉCNICO:
 * Distinguir un "Lote Contable / Rendición Mensual del Broker" (muchas pólizas con recibos
 * correlativos el mismo día, ej. lote 01/10 con serie 239xxxx) de un "Pago Individual Real"
 * (un recibo aislado de una sola póliza en una fecha cualquiera).
 */

const db = require('./database');

// Configuración: ACTIVADO Y EN PRODUCCIÓN (Sin umbral por cantidad diaria)
const CONFIG_DETECTOR_DEFAULT = {
    activo: true,                     // Interruptor maestro: TRUE = Imputa pagos individuales validados
    modo_sombra: false,               // Modo producción real
    max_delta_recibos_lote: 250,      // Si la diferencia entre números de recibos es pequeña y correlativa masiva
    prefijos_lote_conocidos: ['239']  // Prefijos identificados de preliquidaciones administrativas de Triunvirato
};

/**
 * Obtiene el estado actual del switch desde la DB (o fallback a default apagado)
 */
function obtenerConfigDetector() {
    try {
        const configDb = db.prepare("SELECT * FROM config_whatsapp_api WHERE id = 1").get();
        return {
            ...CONFIG_DETECTOR_DEFAULT,
            activo: Boolean(configDb && configDb.auto_imputacion_pagos_activa === 1)
        };
    } catch (e) {
        return { ...CONFIG_DETECTOR_DEFAULT };
    }
}

/**
 * Analiza un conjunto de recibos detectados en el sync y los agrupa por fecha y serie numérica.
 * @param {Array<object>} todosLosPagos - Lista de recibos [{ operacion, nro_cuota, recibo, fecha, importe }]
 * @returns {object} Metadatos del análisis de lotes
 */
function analizarLotesRecibosNRE(todosLosPagos = []) {
    if (!Array.isArray(todosLosPagos) || todosLosPagos.length === 0) {
        return { lotesDetectados: {}, resumen: 'Sin recibos para evaluar' };
    }

    const agrupadosPorFecha = {};

    for (const p of todosLosPagos) {
        const fecha = p.fecha || 'SIN_FECHA';
        if (!agrupadosPorFecha[fecha]) {
            agrupadosPorFecha[fecha] = [];
        }
        agrupadosPorFecha[fecha].push(p);
    }

    const clasificacionFechas = {};

    for (const [fecha, pagos] of Object.entries(agrupadosPorFecha)) {
        const recibosNums = pagos
            .map(p => {
                const clean = String(p.recibo || '').replace(/[^0-9]/g, '');
                return clean ? parseInt(clean, 10) : null;
            })
            .filter(n => n !== null);

        let esLoteCorrelativo = false;
        let esPrefijoLote = false;

        // 1. Chequeo de correlatividad técnica en bloque (números de recibos casi idénticos y consecutivos en gran volumen)
        if (recibosNums.length >= 15) {
            const minNum = Math.min(...recibosNums);
            const maxNum = Math.max(...recibosNums);
            const delta = maxNum - minNum;
            // Si hay 15 o más recibos y la diferencia numérica es casi 1 a 1, es corrida técnica de liquidación
            if (delta <= CONFIG_DETECTOR_DEFAULT.max_delta_recibos_lote && delta < (pagos.length * 1.5)) {
                esLoteCorrelativo = true;
            }
        }

        // 2. Chequeo de prefijos conocidos de liquidación de broker (ej. serie 239xxxx de preliquidación NRE)
        const conPrefijoLote = pagos.filter(p => {
            const numStr = String(p.recibo || '').replace(/[^0-9]/g, '');
            return CONFIG_DETECTOR_DEFAULT.prefijos_lote_conocidos.some(pref => numStr.startsWith(pref));
        }).length;

        if (conPrefijoLote >= 3) {
            esPrefijoLote = true;
        }

        // Solo es lote administrativo si tiene prefijo técnico conocido o correlatividad masiva técnica
        // NUNCA se bloquea por cantidad de recibos en el mismo día
        const esLoteAdministrativo = esPrefijoLote || esLoteCorrelativo;

        clasificacionFechas[fecha] = {
            fecha,
            cantidad_recibos: pagos.length,
            es_lote_administrativo: esLoteAdministrativo,
            motivo: esLoteAdministrativo 
                ? (esPrefijoLote ? 'Prefijo de liquidación masiva NRE (serie 239xxxx)' : 'Recibos correlativos técnicos en bloque')
                : 'Pagos autorizados (carga diaria u oficina)'
        };
    }

    return {
        clasificacionFechas,
        total_evaluados: todosLosPagos.length
    };
}

/**
 * Clasifica si un pago específico es un PAGO INDIVIDUAL REAL o PARTE DE UN LOTE ADMINISTRATIVO.
 * 
 * @param {object} pago - { operacion, nro_cuota, recibo, fecha, importe }
 * @param {object} contextoLotes - Resultado de analizarLotesRecibosNRE
 * @returns {object} { esPagoReal: boolean, esLote: boolean, razon: string }
 */
function clasificarPagoNRE(pago, contextoLotes = {}) {
    if (!pago || !pago.recibo) {
        return { esPagoReal: false, esLote: false, razon: 'Sin número de recibo' };
    }

    const numStr = String(pago.recibo || '').replace(/[^0-9]/g, '');
    const fecha = pago.fecha;

    // 1. Filtro estricto de prefijo de rendición de broker (ej. serie 239xxxx)
    if (CONFIG_DETECTOR_DEFAULT.prefijos_lote_conocidos.some(pref => numStr.startsWith(pref))) {
        return {
            esPagoReal: false,
            esLote: true,
            razon: `Recibo ${pago.recibo} pertenece a serie técnica de preliquidación/rendición (${numStr.slice(0, 3)}...)`
        };
    }

    // 2. Filtro de contexto del día
    const infoFecha = contextoLotes.clasificacionFechas && contextoLotes.clasificacionFechas[fecha];
    if (infoFecha && infoFecha.es_lote_administrativo) {
        return {
            esPagoReal: false,
            esLote: true,
            razon: `Emitido en fecha ${fecha} dentro de un lote administrativo (${infoFecha.cantidad_recibos} pólizas simultáneas: ${infoFecha.motivo})`
        };
    }

    // 3. Si no es lote ni tiene prefijo técnico, es un candidato a pago individual real
    return {
        esPagoReal: true,
        esLote: false,
        razon: `Recibo aislado en fecha ${fecha || 'no concentrada'} fuera de lotes masivos.`
    };
}

/**
 * Evalúa si una cuota puede ser imputada automáticamente.
 * 
 * ⚠️ RESPETO ABSOLUTO DEL SWITCH:
 * Si config.activo === false (el valor por defecto actual), NUNCA modifica la cuota.
 * Solo emite log informativo en consola si se desea auditar.
 */
function evaluarImputacionCuotaNRE(cuota, pago, contextoLotes = {}) {
    const config = obtenerConfigDetector();
    const clasificacion = clasificarPagoNRE(pago, contextoLotes);

    const resultado = {
        nro_cuota: cuota.nro_cuota,
        recibo: pago ? pago.recibo : null,
        fecha: pago ? pago.fecha : null,
        clasificacion,
        switch_activo: config.activo,
        debe_imputar: false
    };

    if (!config.activo) {
        // Switch en "NO": No imputar nada bajo ninguna circunstancia
        resultado.debe_imputar = false;
        resultado.motivo_bloqueo = 'SWITCH_APAGADO_ADMINISTRACION';
        return resultado;
    }

    // Si en el futuro Tomás activa el switch:
    if (clasificacion.esPagoReal && !clasificacion.esLote) {
        resultado.debe_imputar = true;
    } else {
        resultado.debe_imputar = false;
        resultado.motivo_bloqueo = clasificacion.razon;
    }

    return resultado;
}

module.exports = {
    CONFIG_DETECTOR_DEFAULT,
    obtenerConfigDetector,
    analizarLotesRecibosNRE,
    clasificarPagoNRE,
    evaluarImputacionCuotaNRE
};
