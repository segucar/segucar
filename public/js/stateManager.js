/**
 * stateManager.js - Centralized Single Source of Truth & Lifecycle State Machine for SEGUCar
 * Centralizes state calculations, actions, priorities, badge definitions,
 * and automatic lifecycle state transitions for both Cobranza and Renovaciones.
 */

const SeguroStateManager = (function () {
  const ESTADOS = {
    // 💳 COBRANZA — orden: PREVENTIVAS PRIMERO, críticas al final
    AL_DIA: {
      code: 'AL_DIA',
      modulo: 'cobranza',
      label: '🟢 Al Día',
      accion: '🟢 Al día',
      accionDetalle: 'Cliente sin acciones de cobro pendientes',
      prioridadRank: 5,   // sin acción, al fondo
      prioridadLevel: 'baja',
      tagClass: 'tag-green',
      badgeColor: '#2ed573'
    },
    RECORDATORIO_48HS: {
      code: 'RECORDATORIO_48HS',
      modulo: 'cobranza',
      label: '🟡 Recordatorio 48 hs (Preventivo)',
      accion: '🟡 Recordatorio 48 hs (Preventivo)',
      accionDetalle: '📲 Enviar recordatorio preventivo',
      prioridadRank: 1,   // PRIMERO — todavía podemos actuar antes de que pierda cobertura
      prioridadLevel: 'media',
      tagClass: 'tag-amber',
      badgeColor: '#f39c12'
    },
    CUOTA_VENCIDA_0_48HS: {
      code: 'CUOTA_VENCIDA_0_48HS',
      modulo: 'cobranza',
      label: '🟠 Primer Aviso (Vencida hace 48 hs)',
      accion: '🟠 Primer Aviso (Vencida hace 48 hs)',
      accionDetalle: '📲 Enviar primer aviso de pago',
      prioridadRank: 2,
      prioridadLevel: 'alta',
      tagClass: 'tag-orange',
      badgeColor: '#e67e22'
    },
    CUOTA_VENCIDA_48_96HS: {
      code: 'CUOTA_VENCIDA_48_96HS',
      modulo: 'cobranza',
      label: '🔴 Segundo Aviso (Vencida hace 96 hs)',
      accion: '🔴 Segundo Aviso (Vencida hace 96 hs)',
      accionDetalle: '💰 Reclamar pago (Período gracia)',
      prioridadRank: 3,
      prioridadLevel: 'alta',
      tagClass: 'tag-red',
      badgeColor: '#e74c3c'
    },
    MORA_CRITICA_96HS: {
      code: 'MORA_CRITICA_96HS',
      modulo: 'cobranza',
      label: '🚨 Mora Crítica (+96 hs / Perdió Período de Gracia)',
      accion: '🚨 Mora Crítica (+96 hs / Perdió Período de Gracia)',
      accionDetalle: '🚨 Notificar suspensión de cobertura',
      prioridadRank: 4,   // ya perdió cobertura → gestión reactiva
      prioridadLevel: 'critica',
      tagClass: 'tag-red',
      badgeColor: '#ff4757'
    },

    // 🛡️ RENOVACIONES
    RENOVACION_7_DIAS: {
      code: 'RENOVACION_7_DIAS',
      modulo: 'renovaciones',
      label: '📄 Aviso Renovación (Vence en 7 Días)',
      accion: '📄 Aviso Renovación (Vence en 7 Días)',
      accionDetalle: '📄 Propuesta de renovación / reemisión',
      prioridadRank: 6,
      prioridadLevel: 'media',
      tagClass: 'tag-cyan',
      badgeColor: '#00b4d8'
    },
    VENCE_PRONTO: {
      code: 'VENCE_PRONTO',
      modulo: 'renovaciones',
      label: '⚠️ Vence Pronto (0-5 días)',
      accion: '⚠️ Vence Pronto (0-5 días)',
      accionDetalle: '🚨 Renovación urgente — vence en menos de 6 días',
      prioridadRank: 1,
      prioridadLevel: 'critica',
      tagClass: 'tag-orange',
      badgeColor: '#f39c12',
      plantilla: 'renovacion_7_dias'
    },
    POLIZA_VENCIDA: {
      code: 'POLIZA_VENCIDA',
      modulo: 'renovaciones',
      label: '⚫ Póliza Vencida',
      accion: '⚫ Póliza Vencida',
      accionDetalle: '⚫ Póliza dada de baja o vencida',
      prioridadRank: 7,
      prioridadLevel: 'alta',
      tagClass: 'tag-red',
      badgeColor: '#ff4757'
    },
    CONTRATO_VIGENTE: {
      code: 'CONTRATO_VIGENTE',
      modulo: 'renovaciones',
      label: '🟢 Contrato Vigente',
      accion: '🟢 Contrato Vigente',
      accionDetalle: 'Póliza activa sin acciones pendientes',
      prioridadRank: 8,
      prioridadLevel: 'baja',
      tagClass: 'tag-green',
      badgeColor: '#2ed573'
    }
  };

  function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    const clean = String(dateStr).split('T')[0].split(' ')[0];
    const parts = clean.split('-');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }

  function toLocalISOString(date) {
    if (!date) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getVencimientoOperativo(fechaStr) {
    const d = parseLocalDate(fechaStr);
    if (!d) return null;
    const day = d.getDay();
    if (day === 6) { // Saturday -> Monday (+2 days)
      d.setDate(d.getDate() + 2);
    } else if (day === 0) { // Sunday -> Monday (+1 day)
      d.setDate(d.getDate() + 1);
    }
    return toLocalISOString(d);
  }

  function getBusinessDaysDiff(date1, date2) {
    const d1 = parseLocalDate(date1);
    const d2 = parseLocalDate(date2);
    if (!d1 || !d2) return 0;

    d1.setHours(0, 0, 0, 0);
    d2.setHours(0, 0, 0, 0);

    if (d1.getTime() === d2.getTime()) return 0;

    const direction = d2 > d1 ? 1 : -1;
    let diff = 0;
    const current = new Date(d1);

    while (current.getTime() !== d2.getTime()) {
      current.setDate(current.getDate() + direction);
      const day = current.getDay();
      if (day !== 0 && day !== 6) {
        diff += direction;
      }
    }
    return diff;
  }

  function calcularDiasVencimiento(fechaStr) {
    if (!fechaStr) return 999;
    const clean = String(fechaStr).split('T')[0].split(' ')[0];
    const parts = clean.split('-');
    if (parts.length !== 3) return 999;
    const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((targetDate - today) / (1000 * 60 * 60 * 24));
  }

  /**
   * Máquina de Estados del Ciclo de Vida de Póliza (Lifecycle State Machine)
   */
  function determinarEstadoOficial(poliza) {
    if (!poliza) return 'ACTIVA';

    const cuotasAdeudadas = poliza.cuotas_debe ? parseInt(poliza.cuotas_debe) : 0;
    const dias = calcularDiasVencimiento(poliza.fecha_vencimiento);

    if (poliza.es_historica || poliza.dada_de_baja) return 'HISTORICA';
    if (dias < -90 || (dias < -4 && cuotasAdeudadas >= 2)) return 'RECUPERACION';
    if (cuotasAdeudadas > 0 || (dias < 0 && dias >= -4)) return 'REGULARIZAR';
    if (dias >= 0 && dias <= 7) return 'PROXIMA_RENOVAR';

    return 'ACTIVA';
  }

  function evaluarCobranza(poliza, lastSyncDate = null) {
    if (!poliza || !poliza.fecha_vencimiento) return ESTADOS.AL_DIA;

    const saldoPendiente = parseFloat(poliza.saldo_pendiente || 0);
    if (saldoPendiente <= 0) return ESTADOS.AL_DIA;

    const cuotasAdeudadas = poliza.cuotas_debe ? parseInt(poliza.cuotas_debe) : 0;
    
    const parts = poliza.fecha_vencimiento.split('-');
    if (parts.length !== 3) return ESTADOS.AL_DIA;
    const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const calDiff = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));

    const todayStr = toLocalISOString(new Date());

    // Monday sync check:
    const todayDay = new Date().getDay();
    const isMonday = (todayDay === 1);
    const suppressAlerts = isMonday && (lastSyncDate !== todayStr);

    if (suppressAlerts) {
      // Suppress preventivo, primer aviso, segundo aviso on Monday before sync.
      // Mora crítica triggers only if cuotasAdeudadas >= 2 AND calDiff < 0.
      if (calDiff < 0 && cuotasAdeudadas >= 2) {
        return ESTADOS.MORA_CRITICA_96HS;
      }
      return ESTADOS.AL_DIA;
    }

    // 1. 🟡 Recordatorio 48 hs (Preventivo) -> ÚNICAMENTE vencimiento en 2 días (calDiff === 2)
    if (calDiff === 2) {
      return ESTADOS.RECORDATORIO_48HS;
    }

    // 2. 🟠 Primer Aviso -> ÚNICAMENTE vencida hace 2 días (calDiff === -2)
    if (calDiff === -2) {
      return ESTADOS.CUOTA_VENCIDA_0_48HS;
    }

    // 3. 🔴 Segundo Aviso -> ÚNICAMENTE vencida hace 4 días (calDiff === -4)
    if (calDiff === -4) {
      return ESTADOS.CUOTA_VENCIDA_48_96HS;
    }

    // 4. 🚨 Mora Crítica -> ÚNICAMENTE cuotas vencidas hace MÁS de 4 días (> 96 hs: calDiff < -4)
    if (calDiff < -4) {
      return ESTADOS.MORA_CRITICA_96HS;
    }

    return ESTADOS.AL_DIA;
  }

  function evaluarRenovacion(poliza) {
    const fvRen = poliza ? (poliza.fin_vigencia_poliza || poliza.fecha_vencimiento) : null;
    if (!fvRen) return ESTADOS.CONTRATO_VIGENTE;

    const dias = calcularDiasVencimiento(fvRen);
    const saldo = parseFloat(poliza ? (poliza.saldo_pendiente || 0) : 0);
    const cuotas = parseInt(poliza ? (poliza.cuotas_debe || 0) : 0);
    const tieneDeuda = saldo > 0 || cuotas > 0;

    if (dias < 0) {
      return ESTADOS.POLIZA_VENCIDA;
    }

    // Clientes CON deuda en cualquier ventana de aviso → RENOVACION_DEUDA (urgente)
    if (tieneDeuda && dias <= 7 && dias >= 0) {
      return {
        code: 'RENOVACION_DEUDA',
        modulo: 'renovaciones',
        label: '📄 Renovación + Deuda Pendiente',
        accion: '📄 Renovación + Deuda Pendiente',
        accionDetalle: 'Aviso de renovación condicionado a regularización de saldo impago',
        prioridadRank: 2,
        prioridadLevel: 'alta',
        tagClass: 'tag-blue',
        badgeColor: '#00b4d8',
        plantilla: 'renovacion_deuda'
      };
    }

    // Clientes AL DÍA — vence en EXACTAMENTE 7 días → Aviso preventivo normal
    if (!tieneDeuda && dias === 7) {
      return ESTADOS.RENOVACION_7_DIAS;
    }

    // Clientes AL DÍA — vence en 0–6 días → Urgente, renovación inmediata
    if (!tieneDeuda && dias >= 0 && dias <= 6) {
      return ESTADOS.VENCE_PRONTO;
    }

    return ESTADOS.CONTRATO_VIGENTE;
  }

  function evaluarProximaAccion(poliza, lastSyncDate = null) {
    const estadoCob = evaluarCobranza(poliza, lastSyncDate);
    if (estadoCob.code !== 'AL_DIA') {
      const templateMap = {
        'RECORDATORIO_48HS': 'recordatorio_48hs',
        'CUOTA_VENCIDA_0_48HS': 'primer_aviso',
        'CUOTA_VENCIDA_48_96HS': 'segundo_aviso',
        'MORA_CRITICA_96HS': 'mora_critica'
      };
      return {
        codigo: estadoCob.code,
        accion: estadoCob.accionDetalle,
        prioridad: estadoCob.prioridadLevel,
        rank: estadoCob.prioridadRank,
        badgeColor: estadoCob.badgeColor,
        plantilla: templateMap[estadoCob.code] || 'primer_aviso'
      };
    }

    const estadoRen = evaluarRenovacion(poliza);
    if (estadoRen.code !== 'CONTRATO_VIGENTE') {
      const templateMap = {
        'RENOVACION_7_DIAS': 'renovacion_7_dias',
        'POLIZA_VENCIDA': 'poliza_vencida'
      };
      return {
        codigo: estadoRen.code,
        accion: estadoRen.accionDetalle,
        prioridad: estadoRen.prioridadLevel,
        rank: estadoRen.prioridadRank,
        badgeColor: estadoRen.badgeColor,
        plantilla: templateMap[estadoRen.code] || 'renovacion_7_dias'
      };
    }

    return {
      codigo: 'AL_DIA',
      accion: 'Sin acciones pendientes',
      prioridad: 'baja',
      rank: 1,
      badgeColor: '#2ed573',
      plantilla: 'recordatorio_48hs'
    };
  }

  return {
    ESTADOS,
    determinarEstadoOficial,
    evaluarCobranza,
    evaluarRenovacion,
    evaluarProximaAccion,
    calcularDiasVencimiento,
    getVencimientoOperativo,
    getBusinessDaysDiff
  };
})();
