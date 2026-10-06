/**
 * scripts/auditoria_semanal.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Auditoría Automatizada Semanal del Sistema SEGUCar (Lunes 9:00 AM ARG).
 * 
 * Funcionalidades:
 * 1. Inspección de integridad SQLite (pólizas huérfanas, patentes duplicadas).
 * 2. Consistencia de cobranzas (saldos negativos, cuotas inconsistentes, regla remanente).
 * 3. Contactabilidad WhatsApp (teléfonos válidos vs a enriquecer).
 * 4. Estado de sincronización de portales (NRE / AGS) y detector NRE.
 * 5. Ejecución automatizada de la Suite de Regresión (32/32 tests de blindaje).
 * 6. Generación y persistencia de reportes en data/reportes_auditoria/.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function ejecutarAuditoriaSemanal({ guardarArchivo = true } = {}) {
    const inicio = Date.now();
    const db = require('../database');
    const { getArgentinaNow, toLocalDateString } = require('../holidays_ar');
    const { obtenerConfigDetector } = require('../nre_payment_detector');

    const ahoraFecha = getArgentinaNow();
    const fechaStr = typeof ahoraFecha === 'string' ? ahoraFecha : new Date().toISOString().split('T')[0];
    const timestamp = new Date().toISOString();

    console.log(`==================================================`);
    console.log(`🔍 [AUDITORÍA SEMANAL SEGUCar] Iniciando control del ${fechaStr}...`);
    console.log(`==================================================\n`);

    const resultado = {
        fecha: fechaStr,
        timestamp: timestamp,
        estado_general: 'SALUDABLE',
        anomalias: [],
        clientes: {},
        polizas: {},
        cobranzas: {},
        sincronizacion: {},
        tests: {}
    };

    // ── 1. AUDITORÍA DE CLIENTES ──────────────────────────────────────────────
    try {
        const totalClientes = db.prepare('SELECT COUNT(*) as cant FROM clientes').get().cant;
        const conTel = db.prepare("SELECT COUNT(*) as cant FROM clientes WHERE telefono IS NOT NULL AND length(telefono) >= 10 AND telefono GLOB '[0-9]*'").get().cant;
        const sinTel = totalClientes - conTel;
        const conDni = db.prepare("SELECT COUNT(*) as cant FROM clientes WHERE dni IS NOT NULL AND TRIM(dni) != ''").get().cant;

        resultado.clientes = {
            total: totalClientes,
            con_telefono_valido: conTel,
            sin_telefono_valido: sinTel,
            con_dni: conDni,
            cobertura_whatsapp_pct: totalClientes > 0 ? parseFloat(((conTel / totalClientes) * 100).toFixed(1)) : 0
        };
        console.log(`👥 Clientes: ${totalClientes} registrados (${conTel} con WhatsApp válido, ${sinTel} pendientes de normalizar).`);
    } catch (e) {
        resultado.anomalias.push(`Error en conteo de clientes: ${e.message}`);
    }

    // ── 2. AUDITORÍA DE PÓLIZAS E INTEGRIDAD ───────────────────────────────────
    try {
        const totalPolizas = db.prepare('SELECT COUNT(*) as cant FROM polizas').get().cant;
        const anuladas = db.prepare("SELECT COUNT(*) as cant FROM polizas WHERE LOWER(COALESCE(estado, '')) IN ('anulada', 'baja', 'historico') OR anulada = 1").get().cant;
        const activas = totalPolizas - anuladas;

        // Pólizas huérfanas
        const huerfanas = db.prepare('SELECT COUNT(*) as cant FROM polizas WHERE cliente_id NOT IN (SELECT id FROM clientes)').get().cant;
        if (huerfanas > 0) {
            resultado.anomalias.push(`Detectadas ${huerfanas} pólizas huérfanas sin cliente asociado.`);
        }

        // Patentes duplicadas en cartera activa
        const patentesDup = db.prepare(`
            SELECT patente, COUNT(*) as c 
            FROM polizas 
            WHERE LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja', 'historico')
              AND anulada = 0 AND patente IS NOT NULL AND TRIM(patente) != ''
            GROUP BY patente HAVING c > 1
        `).all();
        if (patentesDup.length > 0) {
            resultado.anomalias.push(`Detectadas ${patentesDup.length} patentes duplicadas activas.`);
        }

        // Desglose por aseguradora
        const porAseguradora = db.prepare(`
            SELECT 
                CASE 
                    WHEN aseguradora = 'AGS' OR operacion LIKE 'AGS%' OR operacion LIKE 'AGRO%' THEN 'Agrosalta (AGS)'
                    ELSE 'Triunvirato (NRE)'
                END as aseguradora,
                COUNT(*) as c
            FROM polizas 
            WHERE LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja', 'historico') AND anulada = 0
            GROUP BY aseguradora
        `).all();

        resultado.polizas = {
            total: totalPolizas,
            activas: activas,
            anuladas: anuladas,
            huerfanas: huerfanas,
            patentes_duplicadas: patentesDup.length,
            desglose_aseguradoras: porAseguradora
        };
        console.log(`🛡️ Pólizas: ${totalPolizas} totales (${activas} activas, ${anuladas} anuladas). Pólizas huérfanas: ${huerfanas}.`);
    } catch (e) {
        resultado.anomalias.push(`Error en auditoría de pólizas: ${e.message}`);
    }

    // ── 3. AUDITORÍA DE COBRANZAS Y CUOTAS ─────────────────────────────────────
    try {
        const alDia = db.prepare(`
            SELECT COUNT(*) as cant FROM polizas 
            WHERE saldo_pendiente <= 2500 AND (cuotas_debe = 0 OR cuotas_debe IS NULL)
              AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja', 'historico') AND anulada = 0
        `).get().cant;

        const conDeuda = db.prepare(`
            SELECT COUNT(*) as cant FROM polizas 
            WHERE (saldo_pendiente > 2500 OR cuotas_debe > 0)
              AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja', 'historico') AND anulada = 0
        `).get().cant;

        // Comprobación de anomalías de saldos
        const saldoNegativo = db.prepare('SELECT COUNT(*) as cant FROM polizas WHERE saldo_pendiente < 0').get().cant;
        if (saldoNegativo > 0) {
            resultado.anomalias.push(`Detectadas ${saldoNegativo} pólizas con saldo_pendiente negativo.`);
        }

        const saldoSinCuotas = db.prepare(`
            SELECT COUNT(*) as cant FROM polizas 
            WHERE saldo_pendiente > 2500 AND (cuotas_debe = 0 OR cuotas_debe IS NULL)
              AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja', 'historico') AND anulada = 0
              AND COALESCE(aseguradora, '') != 'AGS'
        `).get().cant;
        if (saldoSinCuotas > 0) {
            resultado.anomalias.push(`Detectadas ${saldoSinCuotas} pólizas con saldo > $2.500 pero cuotas_debe en 0/NULL.`);
        }

        resultado.cobranzas = {
            polizas_al_dia: alDia,
            polizas_con_deuda: conDeuda,
            anomalias_saldo_negativo: saldoNegativo,
            anomalias_saldo_sin_cuotas: saldoSinCuotas
        };
        console.log(`💰 Cobranzas: ${alDia} al día, ${conDeuda} con cuotas pendientes. Remanente <= $2.500 verificado.`);
    } catch (e) {
        resultado.anomalias.push(`Error en auditoría de cobranzas: ${e.message}`);
    }

    // ── 4. ESTADO DE SINCRONIZACIÓN Y DETECTOR NRE ──────────────────────────────
    try {
        const configDetector = obtenerConfigDetector();
        let lastSyncData = null;
        const lastSyncPath = path.join(__dirname, '..', 'data', 'last_sync.json');
        if (fs.existsSync(lastSyncPath)) {
            try {
                lastSyncData = JSON.parse(fs.readFileSync(lastSyncPath, 'utf8'));
            } catch (err) {}
        }

        resultado.sincronizacion = {
            detector_nre_activo: configDetector.activo,
            last_sync_info: lastSyncData
        };

        if (configDetector.activo === true) {
            resultado.anomalias.push(`⚠️ ALERTA: El interruptor del detector NRE está ENCENDIDO (activo: true). Verificar si fue intencional.`);
        }
        console.log(`⚙️ Detector NRE: ${configDetector.activo ? '🟡 ENCENDIDO' : '🟢 APAGADO (Seguro)'}.`);
    } catch (e) {
        resultado.anomalias.push(`Error verificando detector y sync: ${e.message}`);
    }

    // ── 5. EJECUCIÓN DE LA SUITE DE REGRESIÓN (32 TESTS) ────────────────────────
    try {
        console.log(`\n🧪 Corriendo Suite de Regresión Automatizada (npm test)...`);
        const testOutput = execSync('npm test', {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            timeout: 60000
        });

        const passedMatch = testOutput.match(/SUITE DE REGRESIÓN: (\d+)\/(\d+) PASSED/);
        if (passedMatch) {
            const passed = parseInt(passedMatch[1], 10);
            const total = parseInt(passedMatch[2], 10);
            resultado.tests = {
                passed,
                total,
                status: passed === total ? 'ALL_PASSED' : 'SOME_FAILED'
            };
            if (passed === total) {
                console.log(`  🏆 SUITE DE REGRESIÓN: ${passed}/${total} PASSED — BLINDAJE 100% CONFIRMADO.`);
            } else {
                resultado.anomalias.push(`Fallo en suite de regresión: ${passed}/${total} tests aprobados.`);
                console.error(`  ❌ SUITE DE REGRESIÓN: Solo ${passed}/${total} tests pasaron.`);
            }
        } else {
            resultado.tests = { status: 'UNKNOWN_OUTPUT', raw: testOutput.slice(-300) };
        }
    } catch (testError) {
        resultado.tests = { status: 'EXECUTION_ERROR', error: testError.message };
        resultado.anomalias.push(`La suite de regresión arrojó error de ejecución: ${testError.message}`);
    }

    // ── 6. EVALUACIÓN FINAL Y PERSISTENCIA ──────────────────────────────────────
    if (resultado.anomalias.length > 0) {
        resultado.estado_general = 'ATENCION_REQUERIDA';
    }

    const duracionSeg = ((Date.now() - inicio) / 1000).toFixed(1);
    resultado.duracion_segundos = parseFloat(duracionSeg);

    if (guardarArchivo) {
        try {
            const dirReportes = path.join(__dirname, '..', 'data', 'reportes_auditoria');
            if (!fs.existsSync(dirReportes)) {
                fs.mkdirSync(dirReportes, { recursive: true });
            }

            // Guardar JSON estructurado
            const jsonPath = path.join(dirReportes, 'ultimo_reporte.json');
            fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2), 'utf8');

            // Generar Markdown legible
            const mdContent = `
# 🛡️ Reporte Semanal de Auditoría — SEGUCar
**Fecha:** ${resultado.fecha} (${resultado.timestamp})  
**Estado General:** ${resultado.estado_general === 'SALUDABLE' ? '🟢 SALUDABLE — 0 ANOMALÍAS' : '⚠️ ATENCIÓN REQUERIDA'}  
**Duración del Chequeo:** ${duracionSeg} segundos  

---

## 📊 Resumen de Indicadores
- **Clientes:** ${resultado.clientes.total || 0} (${resultado.clientes.con_telefono_valido || 0} con WhatsApp, ${resultado.clientes.sin_telefono_valido || 0} sin teléfono).
- **Pólizas Activas:** ${resultado.polizas.activas || 0} (${resultado.polizas.anuladas || 0} anuladas).
- **Integridad Referencial:** ${resultado.polizas.huerfanas || 0} huérfanas, ${resultado.polizas.patentes_duplicadas || 0} patentes duplicadas.
- **Cobranzas:** ${resultado.cobranzas.polizas_al_dia || 0} al día, ${resultado.cobranzas.polizas_con_deuda || 0} con cuotas pendientes.
- **Suite de Regresión:** ${resultado.tests.passed || 0}/${resultado.tests.total || 0} tests aprobados (${resultado.tests.status || 'N/A'}).
- **Detector NRE:** ${resultado.sincronizacion.detector_nre_activo ? '🟡 Activo' : '🟢 Apagado por seguridad'}.

---

## ⚠️ Anomalías Detectadas (${resultado.anomalias.length})
${resultado.anomalias.length === 0 ? '✅ Ninguna anomalía detectada. El sistema opera al 100% de calibración.' : resultado.anomalias.map(a => `- ${a}`).join('\n')}

---
*Generado automáticamente por el servicio de auditoría semanal de SEGUCar.*
`.trim();

            const mdPath = path.join(dirReportes, `reporte_semanal_${fechaStr}.md`);
            fs.writeFileSync(mdPath, mdContent, 'utf8');

            console.log(`\n📄 Reporte persistido en:`);
            console.log(`   - ${mdPath}`);
            console.log(`   - ${jsonPath}\n`);
        } catch (saveErr) {
            console.error(`Error guardando reporte: ${saveErr.message}`);
        }
    }

    console.log(`==================================================`);
    console.log(`🏁 [AUDITORÍA SEMANAL] Finalizada en ${duracionSeg}s — Estado: ${resultado.estado_general}`);
    console.log(`==================================================\n`);

    return resultado;
}

if (require.main === module) {
    ejecutarAuditoriaSemanal({ guardarArchivo: true })
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Error fatal en auditoría semanal:', err);
            process.exit(1);
        });
}

module.exports = { ejecutarAuditoriaSemanal };
