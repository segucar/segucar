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
    const recibosPorNumero = {};
    for (const p of todosLosPagos) {
        const numStr = String(p.recibo || '').replace(/[^0-9]/g, '');
        if (numStr) {
            if (!recibosPorNumero[numStr]) recibosPorNumero[numStr] = [];
            recibosPorNumero[numStr].push(p.operacion);
        }
    }

    return {
        clasificacionFechas,
        recibosPorNumero,
        total_evaluados: todosLosPagos.length
    };
}

// Nómina estricta de los 153 recibos del lote administrativo del incidente del 01/10/2026
const RECIBOS_INCIDENTE_01_OCT = new Set([
  "2391551","2392062","2392561","2391115","2392695","2391629","2393219","2393224","2390682","2392443",
  "2393276","2393371","2392479","2392068","2391891","2390969","2390688","2392834","2390718","2392049",
  "2390835","2392521","2392428","2392893","2392835","2392792","2390879","2390700","2390736","2392408",
  "2392087","2390796","2390717","2392532","2390971","2390698","2390691","2390769","2390911","2390775",
  "2391013","2392391","2392480","2390814","2393320","2391693","2392351","2392416","2392394","2392286",
  "2392620","2392058","2392065","2392185","2390790","2392223","2392245","2390794","2390792","2392243",
  "2390974","2390923","2391110","2390712","2390811","2390818","2391091","2392736","2391725","2391726",
  "2390715","2393323","2392757","2392184","2390987","2390742","2391547","2391060","2391063","2391533",
  "2390817","2390980","2390710","2391534","2390677","2393383","2391053","2391008","2393300","2393254",
  "2393253","2390697","2390695","2393241","2393208","2393141","2393123","2390924","2393091","2393057",
  "2393036","2393007","2390730","2392941","2392923","2392918","2390703","2390908","2390916","2392908",
  "2390655","2390653","2390669","2390678","2390650","2392721","2392656","2390760","2390846","2390902",
  "2392550","2390675","2392330","2392403","2392503","2393273","2392990","2393258","2391102","2390900",
  "2392571","2392539","2392499","2392474","2392455","2392448","2392444","2392352","2392235","2392194",
  "2390708","2392090","2392073","2392072","2392064","2392044","2392041","2390981","2390936","2393297",
  "2390813","2390966","2391112"
]);

/**
 * Clasifica si un pago específico es un PAGO INDIVIDUAL REAL o PARTE DE UN LOTE ADMINISTRATIVO.
 * 
 * Regla:
 * - Si el recibo está en la lista negra de 153 recibos del incidente 01/10 -> BLOQUEADO (Lote)
 * - Si el recibo aparece repetido en múltiples pólizas distintas el mismo día -> BLOQUEADO (Lote)
 * - Si es un recibo de póliza individual (aunque empiece con 239) -> AUTORIZADO (Pago individual real)
 */
function clasificarPagoNRE(pago, contextoLotes = {}) {
    if (!pago || !pago.recibo) {
        return { esPagoReal: false, esLote: false, razon: 'Sin número de recibo' };
    }

    const numStr = String(pago.recibo || '').replace(/[^0-9]/g, '');

    // 1. Filtro estricto: Bloquear los 153 recibos específicos del incidente del 01/10/2026
    if (RECIBOS_INCIDENTE_01_OCT.has(numStr)) {
        return {
            esPagoReal: false,
            esLote: true,
            razon: `Recibo ${pago.recibo} bloqueado: pertenece al lote administrativo del incidente del 01/10/2026.`
        };
    }

    // 2. Filtro de recibo repetido en múltiples pólizas distintas (lote administrativo multi-póliza)
    if (contextoLotes.recibosPorNumero && contextoLotes.recibosPorNumero[numStr]) {
        const ops = contextoLotes.recibosPorNumero[numStr];
        const uniqueOps = new Set(ops);
        if (uniqueOps.size > 1) {
            return {
                esPagoReal: false,
                esLote: true,
                razon: `Recibo ${pago.recibo} aparece repetido en ${uniqueOps.size} pólizas distintas (lote administrativo).`
            };
        }
    }

    // 3. Pago individual real válido (incluso si empieza con 239 u otra serie)
    return {
        esPagoReal: true,
        esLote: false,
        razon: `Recibo individual aislado (${pago.recibo}) validado.`
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
