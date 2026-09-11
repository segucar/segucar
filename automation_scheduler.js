/**
 * automation_scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Módulo de Automatización Diaria de Cobranzas y Renovaciones (8:00 AM ARG).
 * 
 * Envía automáticamente las 4 plantillas oficiales de WhatsApp:
 * 1. 🟡 Recordatorio 48 hs (Preventivo) -> 'recordatorio_preventivo_48hs'
 * 2. 🟠 Primer Aviso (Vencida 48 hs)   -> 'primer_aviso_vencida_48hs'
 * 3. 🔴 Segundo Aviso (Vencida 96 hs)  -> 'cuota_segundo_aviso_vencida_hace_96_hs'
 * 4. 📄 Aviso Renovación (7 días)      -> 'aviso_renovacion_7_dias'
 * 
 * Protecciones operativas incluidas:
 * - Anti-duplicación / Idempotencia en el mismo día.
 * - Respeto al silenciado de 24 hs por atención humana ('estado_bot').
 * - Rate limiting seguro de 2.5s entre mensajes consecutivos (Anti-Spam Meta).
 * - Exclusión automática de domingos y feriados nacionales argentinos.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { esNoHabil, esHabil, getArgentinaNow, toLocalDateString, evaluarEstadoCobranzaHabil } = require('./holidays_ar');

/**
 * Obtiene hora, minuto, día de la semana y fecha actual en zona horaria de Argentina.
 */
function getInfoHoraArgentina() {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        weekday: 'short'
    });

    const parts = formatter.formatToParts(new Date());
    const getPart = type => parts.find(p => p.type === type)?.value || '';

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hora = parseInt(getPart('hour') || '0', 10);
    const minuto = parseInt(getPart('minute') || '0', 10);
    const diaSemana = getPart('weekday'); // 'Mon', 'Tue', etc.
    const fechaStr = `${year}-${month}-${day}`;
    const esDomingo = diaSemana === 'Sun';

    return {
        hora,
        minuto,
        diaSemana,
        fechaStr,
        esDomingo,
        ahora: new Date(`${fechaStr}T${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}:00-03:00`)
    };
}

/**
 * Normaliza fecha YYYY-MM-DD a medianoche UTC
 */
function normalizarFecha(fecha) {
    if (!fecha) return null;
    if (typeof fecha === 'string') {
        const str = fecha.trim().slice(0, 10);
        const parts = str.split('-');
        if (parts.length === 3) {
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10) - 1;
            const d = parseInt(parts[2], 10);
            if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
                return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
            }
        }
    }
    if (fecha instanceof Date) {
        if (isNaN(fecha.getTime())) return null;
        return new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate(), 0, 0, 0, 0));
    }
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Evalúa y obtiene la lista de pólizas/clientes con notificaciones pendientes para hoy.
 * 
 * @param {object} db - Instancia de better-sqlite3
 * @param {Date|string} [fechaRef=null] - Fecha de referencia (por defecto hoy Argentina)
 * @returns {object} { dia_no_habil: boolean, fecha: string, total: number, pendientes: Array }
 */
function obtenerPendientesHoy(db, fechaRef = null) {
    const infoArg = getInfoHoraArgentina();
    const hoyDate = fechaRef ? normalizarFecha(fechaRef) : normalizarFecha(infoArg.fechaStr);
    const hoyStr = fechaRef ? (typeof fechaRef === 'string' ? fechaRef.slice(0, 10) : toLocalDateString(fechaRef)) : infoArg.fechaStr;

    if (!hoyDate || isNaN(hoyDate.getTime())) {
        throw new Error(`Fecha de referencia inválida: ${fechaRef}`);
    }

    if (esNoHabil(hoyDate)) {
        return {
            dia_no_habil: true,
            fecha: hoyStr,
            total: 0,
            pendientes: []
        };
    }

    const allPolizas = db.prepare(`
        SELECT p.id, p.operacion, p.patente, p.fecha_vencimiento,
               p.fin_vigencia_poliza, p.cuotas_debe, p.saldo_pendiente,
               c.nombre, c.telefono, c.id as cliente_id, p.aseguradora
        FROM polizas p
        JOIN clientes c ON p.cliente_id = c.id
        WHERE c.telefono IS NOT NULL 
          AND length(c.telefono) >= 10
          AND LOWER(COALESCE(p.estado, '')) != 'anulada'
          AND LOWER(COALESCE(p.estado, '')) != 'baja'
        ORDER BY p.id ASC
    `).all();

    // Deduplicación por patente: excluir pólizas reemplazadas por renovaciones más recientes
    const renewedPolizaIds = new Set();
    const polizasByPatente = {};
    for (const p of allPolizas) {
        if (!p.patente) continue;
        if (!polizasByPatente[p.patente]) polizasByPatente[p.patente] = [];
        polizasByPatente[p.patente].push(p);
    }
    for (const pat in polizasByPatente) {
        const group = polizasByPatente[pat];
        if (group.length <= 1) continue;
        group.sort((a, b) => {
            const fvA = a.fin_vigencia_poliza || a.fecha_vencimiento || '';
            const fvB = b.fin_vigencia_poliza || b.fecha_vencimiento || '';
            if (fvA !== fvB) return fvA > fvB ? -1 : 1;
            if (a.aseguradora === b.aseguradora) {
                return (parseInt(b.operacion, 10) || 0) - (parseInt(a.operacion, 10) || 0);
            }
            return 0;
        });
        for (let i = 1; i < group.length; i++) {
            renewedPolizaIds.add(group[i].id);
        }
    }

    const pendientes = [];

    for (const p of allPolizas) {
        if (renewedPolizaIds.has(p.id)) continue;
        if (!p.fecha_vencimiento || !p.telefono) continue;

        const cuotasDebe = parseInt(p.cuotas_debe || 0, 10);
        const saldo = parseFloat(p.saldo_pendiente || 0);

        let tipo = null;
        let plantilla = null;

        // ── 1. Evaluar Cobranzas con la función oficial de días hábiles ──────
        const estadoHabil = evaluarEstadoCobranzaHabil(p.fecha_vencimiento, saldo, hoyDate);

        if (estadoHabil === 'recordatorio_48hs') {
            tipo = 'recordatorio_48hs';
            plantilla = 'recordatorio_preventivo_48hs';
        } else if (estadoHabil === 'cuota_vencida_0_48hs') {
            tipo = 'primer_aviso';
            plantilla = 'primer_aviso_vencida_48hs';
        } else if (estadoHabil === 'cuota_vencida_48_96hs') {
            tipo = 'segundo_aviso';
            plantilla = 'cuota_segundo_aviso_vencida_hace_96_hs';
        }

        // ── 2. Evaluar Renovaciones (Aviso 7 días exactos sin mora grave) ────
        if (!tipo) {
            const fvRen = p.fin_vigencia_poliza || p.fecha_vencimiento;
            if (fvRen) {
                const fvDate = normalizarFecha(fvRen);
                if (fvDate && !isNaN(fvDate.getTime())) {
                    const calDiffRen = Math.round((fvDate - hoyDate) / (1000 * 60 * 60 * 24));
                    
                    let cuotaMoraGrave = false;
                    if (p.fecha_vencimiento && saldo > 2500) {
                        const fvCuotaDate = normalizarFecha(p.fecha_vencimiento);
                        if (fvCuotaDate && !isNaN(fvCuotaDate.getTime())) {
                            cuotaMoraGrave = Math.round((fvCuotaDate - hoyDate) / (1000 * 60 * 60 * 24)) < -5;
                        }
                    }

                    if (calDiffRen === 7 && !cuotaMoraGrave) {
                        tipo = 'renovacion_7_dias';
                        plantilla = 'aviso_renovacion_7_dias';
                    }
                }
            }
        }

        if (tipo && plantilla) {
            pendientes.push({
                cliente_id: p.cliente_id,
                poliza_id: p.id,
                nombre: p.nombre,
                telefono: p.telefono,
                operacion: p.operacion || '',
                patente: p.patente || '',
                fecha_vencimiento: p.fecha_vencimiento,
                fin_vigencia_poliza: p.fin_vigencia_poliza,
                cuotas_debe: cuotasDebe,
                saldo_pendiente: saldo,
                tipo,
                plantilla,
                parametros: [p.operacion || p.patente || '', p.patente || '']
            });
        }
    }

    return {
        dia_no_habil: false,
        fecha: hoyStr,
        total: pendientes.length,
        pendientes
    };
}

/**
 * Verifica si un cliente ya fue contactado hoy (en las últimas 24 hs o en la fecha de hoy ARG).
 * 
 * @param {object} db - Instancia SQLite
 * @param {number} clienteId 
 * @param {string} fechaHoyStr - 'YYYY-MM-DD'
 * @returns {boolean}
 */
function verificarClienteYaContactadoHoy(db, clienteId, fechaHoyStr) {
    if (!clienteId) return false;
    try {
        const reg = db.prepare(`
            SELECT 1 FROM (
                SELECT cliente_id FROM contactos 
                WHERE cliente_id = ? 
                  AND (date(datetime(fecha, '-3 hours')) = ? OR date(fecha) = ?)
                UNION
                SELECT cliente_id FROM mensajes_whatsapp 
                WHERE cliente_id = ? 
                  AND estado = 'enviado'
                  AND (date(datetime(created_at, '-3 hours')) = ? OR date(created_at) = ?)
                UNION
                SELECT cliente_id FROM historial_gestiones_whatsapp 
                WHERE cliente_id = ? 
                  AND (date(datetime(fecha_envio, '-3 hours')) = ? OR date(fecha_envio) = ?)
            ) LIMIT 1
        `).get(clienteId, fechaHoyStr, fechaHoyStr, clienteId, fechaHoyStr, fechaHoyStr, clienteId, fechaHoyStr, fechaHoyStr);

        return !!reg;
    } catch (e) {
        console.error('Error verificando cliente ya contactado hoy:', e.message);
        return false;
    }
}

/**
 * Ejecuta el despacho diario automatizado de WhatsApp.
 * 
 * @param {object} params
 * @param {boolean} [params.dryRun=false] - Modo simulación (no envía mensajes ni escribe en DB)
 * @param {object} params.db - Instancia de base de datos
 * @param {object} params.waService - Módulo de WhatsApp
 * @param {boolean} [params.force=false] - Forzar ejecución ignorando chequeo de día no hábil
 * @param {Date|string} [params.fechaRef=null] - Fecha de referencia opcional
 * @param {number} [params.delayMs=2500] - Milisegundos de espera entre envíos consecutivos
 * @param {function} [params.onProgress=null] - Callback opcional por cada mensaje
 * @returns {Promise<object>} Reporte completo de la ejecución
 */
async function ejecutarDespachoDiario({
    dryRun = false,
    db,
    waService,
    force = false,
    fechaRef = null,
    delayMs = 2500,
    onProgress = null
} = {}) {
    if (!db || !waService) {
        throw new Error('db y waService son requeridos para ejecutar el despacho diario.');
    }

    const { dia_no_habil, fecha, total, pendientes } = obtenerPendientesHoy(db, fechaRef);

    if (dia_no_habil && !force) {
        return {
            ejecutado: false,
            motivo: 'dia_no_habil',
            fecha,
            total_evaluados: 0,
            enviados_count: 0,
            omitidos_silenciados_count: 0,
            omitidos_ya_contactados_count: 0,
            errores_count: 0,
            enviados: [],
            omitidos_silenciados: [],
            omitidos_ya_contactados: [],
            errores: []
        };
    }

    const enviados = [];
    const omitidos_silenciados = [];
    const omitidos_ya_contactados = [];
    const errores = [];

    console.log(`🚀 [Despacho 8AM] Iniciando procesamiento (${dryRun ? 'MODO DRY-RUN' : 'MODO REAL'}). Total pendientes evaluados: ${pendientes.length}`);

    for (let i = 0; i < pendientes.length; i++) {
        const item = pendientes[i];

        // 1. Protección de Idempotencia: ¿Ya fue contactado hoy?
        if (verificarClienteYaContactadoHoy(db, item.cliente_id, fecha)) {
            omitidos_ya_contactados.push({
                cliente_id: item.cliente_id,
                nombre: item.nombre,
                telefono: item.telefono,
                tipo: item.tipo,
                motivo: 'ya_contactado_hoy'
            });
            continue;
        }

        // 2. Protección de Silencio Humano: ¿El bot está silenciado para este teléfono (atendido por humano en últimas 24hs)?
        const estadoBot = waService.getEstadoBot(item.telefono);
        if (estadoBot && estadoBot.bot_activo === false) {
            omitidos_silenciados.push({
                cliente_id: item.cliente_id,
                nombre: item.nombre,
                telefono: item.telefono,
                tipo: item.tipo,
                motivo: 'bot_silenciado_agente_humano',
                silenciado_hasta: estadoBot.silenciado_hasta,
                razon: estadoBot.motivo
            });
            console.log(`🛑 [Despacho 8AM] Omitiendo ${item.telefono} (${item.nombre}) -> Silenciado por agente humano hasta ${estadoBot.silenciado_hasta}`);
            continue;
        }

        // 3. Ejecución / Despacho
        if (dryRun) {
            enviados.push({
                cliente_id: item.cliente_id,
                nombre: item.nombre,
                telefono: item.telefono,
                tipo: item.tipo,
                plantilla: item.plantilla,
                parametros: item.parametros,
                simulado: true
            });
        } else {
            try {
                console.log(`📤 [Despacho 8AM] [${i + 1}/${pendientes.length}] Enviando plantilla "${item.plantilla}" a ${item.telefono} (${item.nombre})...`);

                const result = await waService.sendTemplateMessage(
                    item.cliente_id,
                    item.telefono,
                    item.plantilla,
                    'es_AR',
                    item.parametros,
                    { origen: 'bot', autor: 'scheduler_8am' }
                );

                if (result && result.ok) {
                    // Registrar en tabla 'contactos'
                    db.prepare(`
                        INSERT INTO contactos (cliente_id, poliza_id, tipo, medio, mensaje)
                        VALUES (?, ?, ?, 'whatsapp', ?)
                    `).run(item.cliente_id, item.poliza_id, item.plantilla, `[Despacho Automático 8AM] Plantilla: ${item.plantilla}`);

                    // Registrar en historial_gestiones_whatsapp para métricas comerciales
                    db.prepare(`
                        UPDATE historial_gestiones_whatsapp
                        SET estado_resultado = 'reemplazada', fecha_resolucion = CURRENT_TIMESTAMP
                        WHERE cliente_id = ? AND (poliza_id = ? OR poliza_id IS NULL) AND estado_resultado = 'pendiente'
                    `).run(item.cliente_id, item.poliza_id);

                    db.prepare(`
                        INSERT INTO historial_gestiones_whatsapp (cliente_id, poliza_id, tipo_plantilla, saldo_al_enviar, estado_resultado)
                        VALUES (?, ?, ?, ?, 'pendiente')
                    `).run(item.cliente_id, item.poliza_id, item.tipo, item.saldo_pendiente || 0);

                    enviados.push({
                        cliente_id: item.cliente_id,
                        nombre: item.nombre,
                        telefono: item.telefono,
                        tipo: item.tipo,
                        plantilla: item.plantilla,
                        wa_message_id: result.wa_message_id || result.id || null
                    });
                } else {
                    errores.push({
                        cliente_id: item.cliente_id,
                        nombre: item.nombre,
                        telefono: item.telefono,
                        tipo: item.tipo,
                        plantilla: item.plantilla,
                        error: result?.error || 'Error desconocido al enviar plantilla'
                    });
                }
            } catch (err) {
                errores.push({
                    cliente_id: item.cliente_id,
                    nombre: item.nombre,
                    telefono: item.telefono,
                    tipo: item.tipo,
                    plantilla: item.plantilla,
                    error: err.message
                });
            }

            if (onProgress) {
                try { onProgress({ actual: i + 1, total: pendientes.length, item }); } catch (e) {}
            }

            // Pausa de rate limiting anti-spam entre mensajes consecutivos
            if (i < pendientes.length - 1 && delayMs > 0) {
                await new Promise(res => setTimeout(res, delayMs));
            }
        }
    }

    const summary = {
        ejecutado: true,
        dry_run: dryRun,
        fecha,
        total_evaluados: pendientes.length,
        enviados_count: enviados.length,
        omitidos_silenciados_count: omitidos_silenciados.length,
        omitidos_ya_contactados_count: omitidos_ya_contactados.length,
        errores_count: errores.length,
        enviados,
        omitidos_silenciados,
        omitidos_ya_contactados,
        errores
    };

    console.log(`🏁 [Despacho 8AM] Finalizado — Enviados: ${enviados.length}, Omitidos Silenciados: ${omitidos_silenciados.length}, Omitidos Ya Contactados: ${omitidos_ya_contactados.length}, Errores: ${errores.length}`);

    return summary;
}

/**
 * Inicia el temporizador en segundo plano para ejecutar el despacho automático
 * todos los días hábiles a las 8:00 AM (Hora Argentina).
 * 
 * @param {object} params
 * @param {object} params.db - Instancia SQLite
 * @param {object} params.waService - Módulo de WhatsApp
 */
function iniciarScheduler8AM({ db, waService }) {
    let ultimoDespachoFecha = null;
    let isRunning = false;

    console.log('⏰ [Automation Scheduler] Programado: Lunes a Sábados a las 8:00 AM (Hora Argentina)');

    setInterval(async () => {
        const info = getInfoHoraArgentina();

        // Chequear ventana de ejecución: 8:00 AM a 8:30 AM
        if (info.hora === 8 && info.minuto >= 0 && info.minuto <= 30) {
            if (ultimoDespachoFecha === info.fechaStr) {
                // Ya se ejecutó hoy
                return;
            }

            if (info.esDomingo) {
                console.log(`⏭️ [Despacho 8AM] Omitido automáticamente: Domingo (${info.fechaStr})`);
                ultimoDespachoFecha = info.fechaStr;
                return;
            }

            if (isRunning) {
                return;
            }

            try {
                isRunning = true;
                ultimoDespachoFecha = info.fechaStr;
                console.log(`🌅 [Despacho 8AM] Disparando despacho automático de las 8:00 AM (${info.fechaStr})...`);

                const result = await ejecutarDespachoDiario({
                    dryRun: false,
                    db,
                    waService,
                    delayMs: 2500
                });

                console.log(`✅ [Despacho 8AM] Resultado del día ${info.fechaStr}:`, {
                    ejecutado: result.ejecutado,
                    enviados: result.enviados_count,
                    silenciados: result.omitidos_silenciados_count,
                    ya_contactados: result.omitidos_ya_contactados_count,
                    errores: result.errores_count
                });
            } catch (err) {
                console.error(`❌ [Despacho 8AM] Error durante la ejecución del despacho diario:`, err);
            } finally {
                isRunning = false;
            }
        }
    }, 60 * 1000); // Revisión cada 60 segundos
}

module.exports = {
    getInfoHoraArgentina,
    obtenerPendientesHoy,
    verificarClienteYaContactadoHoy,
    ejecutarDespachoDiario,
    iniciarScheduler8AM
};
