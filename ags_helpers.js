'use strict';

/**
 * ags_helpers.js
 * Funciones puras de cálculo de cronograma AGS (4 cuotas).
 * Extraídas de sync_ags.js para romper la dependencia circular
 * database.js → sync_ags.js → database.js
 */

// AGS siempre factura en 4 cuotas
const AGS_TOTAL_CUOTAS = 4;

function calcularFechaCuotaAGS(finVigenciaStr, mesesAntes) {
    const parts = String(finVigenciaStr).split('T')[0].split('-');
    if (parts.length !== 3) return finVigenciaStr;
    let y = parseInt(parts[0], 10);
    let m = parseInt(parts[1], 10) - 1; // 0-indexed
    let d = parseInt(parts[2], 10);

    let targetMonth = m - mesesAntes;
    while (targetMonth < 0) {
        targetMonth += 12;
        y -= 1;
    }
    const daysInMonth = new Date(y, targetMonth + 1, 0).getDate();
    const safeDay = Math.min(d, daysInMonth);

    const mm = String(targetMonth + 1).padStart(2, '0');
    const dd = String(safeDay).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
}

function generarCronogramaCuotasAGS(finVigencia, premio, historialExistente = null) {
    const hoyStr = new Date().toISOString().slice(0, 10);
    const montoCuota = premio > 0 ? Math.round((premio / AGS_TOTAL_CUOTAS) * 100) / 100 : 0;
    
    let histMap = {};
    if (historialExistente) {
        try {
            const parsed = typeof historialExistente === 'string' ? JSON.parse(historialExistente) : historialExistente;
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (item && item.nro_cuota) histMap[item.nro_cuota] = item;
                }
            }
        } catch(e) {}
    }

    const cuotas = [];
    for (let i = 1; i <= AGS_TOTAL_CUOTAS; i++) {
        const vto = calcularFechaCuotaAGS(finVigencia, AGS_TOTAL_CUOTAS - i + 1);
        const existing = histMap[i];

        if (existing) {
            cuotas.push({
                nro_cuota: i,
                vto_cuota: existing.vto_cuota || vto,
                saldo_cli: existing.saldo_cli !== undefined ? existing.saldo_cli : (existing.estado === 'PAGADA' ? 0 : montoCuota),
                estado: existing.estado || (vto < hoyStr ? 'PAGADA' : 'PENDIENTE'),
                fecha_pago: existing.fecha_pago || (existing.estado === 'PAGADA' ? 'Registrado en AGS' : null),
                lote: existing.lote || 'Sincronizado con AGS'
            });
        } else {
            // Por defecto: cuotas pasadas que no están en mora se consideran pagadas; la cuota actual/futura está pendiente
            const esPasada = vto < hoyStr;
            cuotas.push({
                nro_cuota: i,
                vto_cuota: vto,
                saldo_cli: esPasada ? 0 : montoCuota,
                estado: esPasada ? 'PAGADA' : 'PENDIENTE',
                fecha_pago: esPasada ? 'Registrado en AGS' : null,
                lote: 'Sincronizado con AGS'
            });
        }
    }

    // Determinar próxima cuota activa / cuota impaga
    const cuotasImpagas = cuotas.filter(c => c.estado === 'PENDIENTE' || c.saldo_cli > 0);
    const cuotasVencidas = cuotasImpagas.filter(c => c.vto_cuota && c.vto_cuota < hoyStr);

    let nroCuotaActiva = AGS_TOTAL_CUOTAS;
    let fechaVtoActiva = finVigencia;
    let cuotasDebe = cuotasVencidas.length;
    let saldoPendiente = cuotasImpagas.reduce((sum, c) => sum + (parseFloat(c.saldo_cli) || 0), 0);

    if (cuotasVencidas.length > 0) {
        // Hay cuotas vencidas impagas -> la activa es la primera vencida
        cuotasVencidas.sort((a, b) => (a.vto_cuota < b.vto_cuota ? -1 : 1));
        nroCuotaActiva = cuotasVencidas[0].nro_cuota;
        fechaVtoActiva = cuotasVencidas[0].vto_cuota;
    } else if (cuotasImpagas.length > 0) {
        // No hay mora, próxima cuota a vencer
        cuotasImpagas.sort((a, b) => (a.vto_cuota < b.vto_cuota ? -1 : 1));
        nroCuotaActiva = cuotasImpagas[0].nro_cuota;
        fechaVtoActiva = cuotasImpagas[0].vto_cuota;
    }

    return {
        cuotas,
        nro_cuota: nroCuotaActiva,
        fecha_vencimiento: fechaVtoActiva,
        cuotas_debe: cuotasDebe,
        saldo_pendiente: saldoPendiente,
        total_cuotas: AGS_TOTAL_CUOTAS
    };
}

module.exports = { generarCronogramaCuotasAGS, calcularFechaCuotaAGS, AGS_TOTAL_CUOTAS };
