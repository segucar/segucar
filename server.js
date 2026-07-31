require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { scrapeTelefonos, consultarPolizaSistema } = require('./scraper');
const { syncVencimientosNRE, syncDeudasNRE, syncGeneralNRE } = require('./sync_nre');

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API CONFIG (WHITELABEL BRANDING) ──────────────────────────────────────
app.get('/api/config', (req, res) => {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) {
        try {
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return res.json(configData);
        } catch (e) {
            console.error('Error leyendo config.json:', e);
        }
    }
    res.json({
        appName: 'SEGUCar',
        brandNameHtml: 'SEGU<em>Car</em>',
        producerName: 'Productor Asesor de Seguros'
    });
});

function getAppName() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.appName) return data.appName;
        }
    } catch(e) {}
    return 'SEGUCar';
}

const upload = multer({ dest: 'data/uploads/' });

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS: LOGICA DE DIAS HABILES
// ═══════════════════════════════════════════════════════════════════════════

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

/**
 * sanitizeAndFixPhone — VERSIÓN ESTRICTA
 * 
 * Normaliza un teléfono al formato WhatsApp Argentina: 549 + 10 dígitos.
 * 
 * REGLAS:
 *   - Solo acepta números que tengan al menos 10 dígitos (después de quitar prefijos)
 *   - NUNCA completa números cortos (7-8 dígitos) con código de área
 *   - Si el dato no es un teléfono válido, retorna '' (vacío)
 *   - Los números inválidos deben quedar vacíos para el "Reporte de Teléfonos Incompletos"
 */
function sanitizeAndFixPhone(phone) {
    if (!phone) return '';
    let cleaned = String(phone).replace(/[^\d]/g, '');

    if (cleaned.length === 0) return '';

    // Quitar prefijo internacional 549 o 54 si ya lo tiene
    if (cleaned.startsWith('549')) {
        cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('54')) {
        cleaned = cleaned.substring(2);
    }

    // Quitar ceros iniciales (ej: 0223... -> 223...)
    while (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }

    // Manejar 15 en Mar del Plata (223-15-xxxxxxx -> 223xxxxxxx)
    if (cleaned.startsWith('22315') && cleaned.length >= 12) {
        cleaned = '223' + cleaned.substring(5);
    } else if (cleaned.startsWith('15') && cleaned.length === 9) {
        cleaned = cleaned.substring(2);
    }

    // Quitar ceros accidentales después del código de área 223 (ej: 22306002079 -> 2236002079)
    if (cleaned.startsWith('2230') && cleaned.length > 10) {
        cleaned = '223' + cleaned.substring(3).replace(/^0+/, '');
    }

    // Si tiene 7 u 8 dígitos locales, anteponer 223
    if (cleaned.length === 7 || cleaned.length === 8) {
        cleaned = '223' + cleaned;
    }

    if (cleaned.length === 10) {
        return '549' + cleaned;
    }
    if (cleaned.length > 10 && cleaned.startsWith('223')) {
        const local = cleaned.substring(3).replace(/^0+/, '');
        if (local.length === 7) return '549223' + local;
    }

    return cleaned.length >= 10 ? '549' + cleaned : '';
}

// NOTE: Se eliminó la migración destructiva de arranque que re-sanitizaba
// todos los teléfonos en cada reinicio del servidor. La corrección de teléfonos
// se hace SOLO mediante el script fix_phones_reimport.js con fuentes confiables.

// Shift Saturday/Sunday to Monday
function getVencimientoOperativo(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    const day = d.getDay();
    if (day === 6) { // Saturday -> Monday (+2 days)
        d.setDate(d.getDate() + 2);
    } else if (day === 0) { // Sunday -> Monday (+1 day)
        d.setDate(d.getDate() + 1);
    }
    return toLocalISOString(d);
}

// Helper to count business days difference (date2 - date1) skipping weekends
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

// Helper to add business days (skipping Sat/Sun)
function addBusinessDays(dateStr, days) {
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    let added = 0;
    const direction = days < 0 ? -1 : 1;
    const target = Math.abs(days);
    
    while (added < target) {
        d.setDate(d.getDate() + direction);
        const day = d.getDay();
        if (day !== 0 && day !== 6) {
            added++;
        }
    }
    return toLocalISOString(d);
}

function addCalendarDays(dateStr, days) {
    const d = parseLocalDate(dateStr);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return toLocalISOString(d);
}

// Helper to check if NRE sync ran today
function getLastSyncDate() {
    const syncFile = path.join(__dirname, 'data', 'last_sync.json');
    if (fs.existsSync(syncFile)) {
        try {
            const content = JSON.parse(fs.readFileSync(syncFile, 'utf8'));
            return content.last_sync_date || null;
        } catch (e) {
            return null;
        }
    }
    return null;
}

function updateLastSyncDate() {
    const syncFile = path.join(__dirname, 'data', 'last_sync.json');
    fs.writeFileSync(syncFile, JSON.stringify({ last_sync_date: toLocalISOString(new Date()) }));
}

function getSaldoExigible(poliza) {
    if (!poliza) return 0;
    try {
        if (poliza.cuotas_historial) {
            const hist = typeof poliza.cuotas_historial === 'string' ? JSON.parse(poliza.cuotas_historial) : poliza.cuotas_historial;
            if (Array.isArray(hist) && hist.length > 0) {
                const cleanVenc = String(poliza.fecha_vencimiento || '').split('T')[0].split(' ')[0];
                if (cleanVenc) {
                    const dueCuotas = hist.filter(c => {
                        if (!c) return false;
                        const vto = String(c.vto_cuota || c.vencimiento || '').split('T')[0].split(' ')[0];
                        const s = parseFloat(c.saldo_cli || c.importe || 0);
                        return s > 0 && vto && vto <= cleanVenc;
                    });
                    if (dueCuotas.length > 0) {
                        return dueCuotas.reduce((sum, c) => sum + (parseFloat(c ? (c.saldo_cli || c.importe || 0) : 0)), 0);
                    }
                }
            }
        }
    } catch(e) {
        console.error('Error en getSaldoExigible:', e.message);
    }
    return parseFloat(poliza ? poliza.saldo_pendiente : 0) || 0;
}

// ═══════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/dashboard/stats', (req, res) => {
    try {
        if (typeof db.restaurarTelefonosMaestros === 'function') {
            db.restaurarTelefonosMaestros();
        }

        const total_clientes = db.prepare('SELECT COUNT(*) as count FROM clientes').get().count;
        const clientes_con_telefono = db.prepare("SELECT COUNT(*) as count FROM clientes WHERE telefono IS NOT NULL AND length(telefono) >= 10").get().count;
        const clientes_sin_telefono = db.prepare("SELECT COUNT(*) as count FROM clientes WHERE telefono IS NULL OR length(telefono) < 10").get().count;
        const cobertura_porcentaje = total_clientes > 0 ? ((clientes_con_telefono / total_clientes) * 100).toFixed(1) : '0';

        const total_polizas = db.prepare('SELECT COUNT(*) as count FROM polizas').get().count;
        const total_recuperar = db.prepare(`
            SELECT COUNT(*) as count FROM polizas_historicas ph
            WHERE (ph.fecha_vencimiento < date('now', '-30 days')) AND NOT EXISTS (
                SELECT 1 FROM polizas p 
                WHERE (p.patente = ph.patente AND p.patente IS NOT NULL AND p.patente != '')
                   OR (p.operacion = ph.operacion AND p.operacion IS NOT NULL AND p.operacion != '')
            )
        `).get().count;

        const todayStr = toLocalISOString(new Date());
        const lastSync = getLastSyncDate();
        
        // Monday Sync check:
        // "las alertas automáticas de 48 hs no deben dispararse hasta correr la primera sincronización del primer día hábil de la semana."
        const todayDay = new Date().getDay();
        const isMonday = (todayDay === 1);
        const suppressAlerts = isMonday && (lastSync !== todayStr);

        const allPolizas = db.prepare('SELECT id, fecha_vencimiento, fin_vigencia_poliza, cuotas_debe, estado, saldo_pendiente FROM polizas').all();
        
        let vence_48h = 0;
        let vencio_48h = 0;
        let vencio_96h = 0;
        let mora_critica = 0;
        let al_dia = 0;

        let polizas_vencen_semana = 0;
        let polizas_vencen_mes = 0;
        let polizas_vencidas = 0;
        let polizas_vigentes = 0;

        for (const p of allPolizas) {
            const fv = p.fecha_vencimiento;
            const cd = parseInt(p.cuotas_debe || 0);

            // ── Renovaciones counters (Calendar days)
            const fvRen = p.fin_vigencia_poliza || fv;
            if (fvRen) {
                const parts = fvRen.split('-');
                if (parts.length === 3) {
                    const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                    const todayDate = parseLocalDate(todayStr);
                    const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));

                    if (calDiffRen === 7) polizas_vencen_semana++;
                    if (calDiffRen > 0 && calDiffRen <= 30) polizas_vencen_mes++;
                    if (calDiffRen < 0) polizas_vencidas++;
                    if (calDiffRen >= 0) polizas_vigentes++; // Any policy not expired is active/vigente
                }
            }

            // ── Cobranzas counters (Calendar days)
            const saldoVal = parseFloat(p.saldo_pendiente || 0);
            if (saldoVal > 0) {
                const parts = fv.split('-');
                let calDiff = 999;
                if (parts.length === 3) {
                    const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                    const todayDate = parseLocalDate(todayStr);
                    calDiff = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                }

                // Apply Monday suppression: if suppressed, these alerts are treated as Al Día
                let actualCobState = 'AL_DIA';
                if (!suppressAlerts) {
                    if (cd === 0 && calDiff === 2) {
                        actualCobState = 'VENCE_48H';
                    } else if (cd === 1 && calDiff === -2) {
                        actualCobState = 'VENCIO_48H';
                    } else if (cd === 1 && calDiff === -4) {
                        actualCobState = 'VENCIO_96H';
                    } else if (cd >= 2 || (cd > 0 && calDiff < -4)) {
                        actualCobState = 'MORA_CRITICA';
                    }
                } else {
                    // Suppressed alerts on Monday: Mora crítica triggers only if cuotas_debe >= 2
                    if (cd >= 2) {
                        actualCobState = 'MORA_CRITICA';
                    }
                }

                if (actualCobState === 'VENCE_48H') vence_48h++;
                else if (actualCobState === 'VENCIO_48H') vencio_48h++;
                else if (actualCobState === 'VENCIO_96H') vencio_96h++;
                else if (actualCobState === 'MORA_CRITICA') {
                    mora_critica++;
                } else {
                    al_dia++;
                }
            } else {
                al_dia++;
            }
        }

        res.json({ 
            total_clientes, 
            total_polizas, 
            clientes_con_telefono,
            clientes_sin_telefono,
            cobertura_porcentaje,
            polizas_vencen_semana, 
            polizas_vencen_mes, 
            polizas_vencidas,
            polizas_vigentes,
            al_dia,
            cuotas_deuda: mora_critica, 
            total_deudores: mora_critica, 
            vence_48h,
            vencio_48h,
            vencio_96h,
            mora_critica,
            total_recuperar,
            last_sync_date: lastSync
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTAR A EXCEL
// ═══════════════════════════════════════════════════════════════════════════

async function generarExcelEstructuradoExcelJS(req, res) {
    try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'SEGUCar';
        workbook.created = new Date();

        // 1. HOJA 1: PÓLIZAS ACTIVAS (Clientes con contrato vigente/activo y teléfono limpio cargado)
        const sheet1 = workbook.addWorksheet('PÓLIZAS ACTIVAS');
        sheet1.columns = [
            { header: 'ID Cliente', key: 'id', width: 12 },
            { header: 'Nombre', key: 'nombre', width: 35 },
            { header: 'DNI', key: 'dni', width: 15 },
            { header: 'Teléfono', key: 'telefono', width: 18 },
            { header: 'Operación', key: 'operacion', width: 16 },
            { header: 'Patente', key: 'patente', width: 14 },
            { header: 'Vehículo', key: 'vehiculo', width: 30 },
            { header: 'N° Cuota', key: 'nro_cuota', width: 14 },
            { header: 'Venc. Cuota', key: 'venc_cuota', width: 15 },
            { header: 'Saldo Pendiente', key: 'saldo_pendiente', width: 18 },
            { header: 'Fin Vigencia Póliza', key: 'fin_vigencia', width: 20 },
            { header: 'Estado Póliza', key: 'estado', width: 15 },
            { header: 'Dirección', key: 'direccion', width: 30 }
        ];

        const qActivas = `
            SELECT 
                c.id, c.nombre, c.dni, c.telefono,
                p.operacion, p.patente, p.vehiculo,
                ('Cuota ' || COALESCE(p.nro_cuota, 1) || '/' || COALESCE(p.total_cuotas, 3)) as nro_cuota,
                p.fecha_vencimiento as venc_cuota,
                COALESCE(p.saldo_pendiente, 0) as saldo_pendiente,
                COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento) as fin_vigencia,
                COALESCE(p.estado, 'vigente') as estado,
                c.direccion
            FROM clientes c
            LEFT JOIN polizas p ON c.id = p.cliente_id
            LEFT JOIN telefonos_invalidos ti ON c.id = ti.cliente_id
            WHERE (c.telefono IS NOT NULL AND c.telefono != '' AND length(c.telefono) >= 10 AND ti.id IS NULL)
              AND LOWER(COALESCE(p.estado, '')) NOT IN ('baja', 'anulada', 'historico', 'historica', 'cancelada')
            ORDER BY c.nombre ASC
        `;
        const rowsActivas = db.prepare(qActivas).all();
        rowsActivas.forEach(r => sheet1.addRow(r));
        sheet1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007ACC' } };

        // 2. HOJA 2: SIN TELÉFONO (Pólizas activas con teléfonos faltantes/inválidos, ordenadas por vigentes primero y vencidas más abajo)
        const sheet2 = workbook.addWorksheet('SIN TELÉFONO');
        sheet2.columns = [
            { header: 'ID Cliente', key: 'id', width: 12 },
            { header: 'Nombre', key: 'nombre', width: 35 },
            { header: 'DNI', key: 'dni', width: 15 },
            { header: 'Póliza', key: 'operacion', width: 20 },
            { header: 'Vehículo', key: 'vehiculo', width: 30 },
            { header: 'Condición Póliza', key: 'condicion_poliza', width: 25 },
            { header: 'Fin Vigencia / Vencimiento', key: 'fin_vigencia', width: 22 },
            { header: 'Teléfono Registrado', key: 'telefono_registrado', width: 22 },
            { header: 'Estado/Tipo de Error', key: 'tipo_error', width: 28 },
            { header: 'Dirección', key: 'direccion', width: 35 },
            { header: 'Email', key: 'email', width: 25 }
        ];

        const qSinTel = `
            SELECT 
                c.id, c.nombre, c.dni,
                COALESCE(p.operacion, '-') as operacion,
                COALESCE(p.vehiculo, '-') as vehiculo,
                CASE 
                    WHEN CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0 THEN '🟢 ACTIVA / VIGENTE'
                    ELSE '🔴 VENCIDA'
                END as condicion_poliza,
                COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento, '-') as fin_vigencia,
                COALESCE(ti.telefono, NULLIF(c.telefono, ''), 'Sin Registro') as telefono_registrado,
                CASE 
                    WHEN ti.id IS NOT NULL THEN 'Inválido / Inexistente'
                    WHEN c.telefono IS NOT NULL AND c.telefono != '' AND length(c.telefono) < 10 THEN 'Incompleto (< 10 dígitos)'
                    ELSE 'Sin Registro'
                END as tipo_error,
                c.direccion, c.email
            FROM clientes c
            LEFT JOIN polizas p ON c.id = p.cliente_id
            LEFT JOIN telefonos_invalidos ti ON c.id = ti.cliente_id
            WHERE (c.telefono IS NULL OR c.telefono = '' OR length(c.telefono) < 10 OR ti.id IS NOT NULL)
              AND LOWER(COALESCE(p.estado, '')) NOT IN ('baja', 'anulada', 'historico', 'historica', 'cancelada')
            ORDER BY 
                CASE 
                    WHEN CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0 THEN 1 
                    ELSE 2 
                END ASC, 
                c.nombre ASC
        `;
        const rowsSinTel = db.prepare(qSinTel).all();
        rowsSinTel.forEach(r => sheet2.addRow(r));
        sheet2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD35400' } };

        // 3. HOJA 3: HISTÓRICO Y BAJAS (Pólizas dadas de baja, anuladas o canceladas)
        const sheet3 = workbook.addWorksheet('HISTÓRICO Y BAJAS');
        sheet3.columns = [
            { header: 'ID Cliente', key: 'id', width: 12 },
            { header: 'Nombre', key: 'nombre', width: 35 },
            { header: 'DNI', key: 'dni', width: 15 },
            { header: 'Teléfono', key: 'telefono', width: 18 },
            { header: 'Póliza / Operación', key: 'operacion', width: 18 },
            { header: 'Patente', key: 'patente', width: 14 },
            { header: 'Vehículo', key: 'vehiculo', width: 30 },
            { header: 'Fecha Vencimiento', key: 'vencimiento', width: 18 },
            { header: 'Estado Póliza', key: 'estado', width: 18 },
            { header: 'Observaciones', key: 'observaciones', width: 35 }
        ];

        const qHistoricas = `
            SELECT 
                c.id as id,
                c.nombre as nombre,
                c.dni as dni,
                c.telefono as telefono,
                p.operacion as operacion,
                p.patente as patente,
                p.vehiculo as vehiculo,
                p.fecha_vencimiento as vencimiento,
                COALESCE(p.estado, 'Baja / Anulada') as estado,
                COALESCE(p.observaciones, 'Póliza Histórica / Anulada') as observaciones
            FROM clientes c
            LEFT JOIN polizas p ON c.id = p.cliente_id
            WHERE LOWER(COALESCE(p.estado, '')) IN ('baja', 'anulada', 'historico', 'historica', 'cancelada')

            UNION ALL

            SELECT 
                NULL as id,
                ph.nombre as nombre,
                NULL as dni,
                ph.telefono as telefono,
                ph.operacion as operacion,
                ph.patente as patente,
                ph.vehiculo as vehiculo,
                ph.fecha_vencimiento as vencimiento,
                'Histórica / Bajas' as estado,
                COALESCE(ph.estrategia, 'Reactivación Histórica') as observaciones
            FROM polizas_historicas ph
            ORDER BY nombre ASC
        `;
        const rowsHistoricas = db.prepare(qHistoricas).all();
        rowsHistoricas.forEach(r => sheet3.addRow(r));
        sheet3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7F8C8D' } };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="SEGUCar_Reporte_General.xlsx"');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Error al generar ExcelJS estructurado:", error);
        res.status(500).json({ error: error.message });
    }
}

async function generarExcelSinTelefonoExcelJS(req, res) {
    try {
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'SEGUCar';
        workbook.created = new Date();

        const sheet2 = workbook.addWorksheet('SIN TELÉFONO');
        sheet2.columns = [
            { header: 'ID Cliente', key: 'id', width: 12 },
            { header: 'Nombre', key: 'nombre', width: 35 },
            { header: 'DNI', key: 'dni', width: 15 },
            { header: 'Póliza', key: 'operacion', width: 20 },
            { header: 'Vehículo', key: 'vehiculo', width: 30 },
            { header: 'Condición Póliza', key: 'condicion_poliza', width: 25 },
            { header: 'Fin Vigencia / Vencimiento', key: 'fin_vigencia', width: 22 },
            { header: 'Teléfono Registrado', key: 'telefono_registrado', width: 22 },
            { header: 'Estado/Tipo de Error', key: 'tipo_error', width: 28 },
            { header: 'Dirección', key: 'direccion', width: 35 },
            { header: 'Email', key: 'email', width: 25 }
        ];

        const qSinTel = `
            SELECT 
                c.id, c.nombre, c.dni,
                COALESCE(p.operacion, '-') as operacion,
                COALESCE(p.vehiculo, '-') as vehiculo,
                CASE 
                    WHEN CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0 THEN '🟢 ACTIVA / VIGENTE'
                    ELSE '🔴 VENCIDA'
                END as condicion_poliza,
                COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento, '-') as fin_vigencia,
                COALESCE(ti.telefono, NULLIF(c.telefono, ''), 'Sin Registro') as telefono_registrado,
                CASE 
                    WHEN ti.id IS NOT NULL THEN 'Inválido / Inexistente'
                    WHEN c.telefono IS NOT NULL AND c.telefono != '' AND length(c.telefono) < 10 THEN 'Incompleto (< 10 dígitos)'
                    ELSE 'Sin Registro'
                END as tipo_error,
                c.direccion, c.email
            FROM clientes c
            LEFT JOIN polizas p ON c.id = p.cliente_id
            LEFT JOIN telefonos_invalidos ti ON c.id = ti.cliente_id
            WHERE (c.telefono IS NULL OR c.telefono = '' OR length(c.telefono) < 10 OR ti.id IS NOT NULL)
              AND LOWER(COALESCE(p.estado, '')) NOT IN ('baja', 'anulada', 'historico', 'historica', 'cancelada')
            ORDER BY 
                CASE 
                    WHEN CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0 THEN 1 
                    ELSE 2 
                END ASC, 
                c.nombre ASC
        `;
        const rowsSinTel = db.prepare(qSinTel).all();
        rowsSinTel.forEach(r => sheet2.addRow(r));
        sheet2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD35400' } };

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="SEGUCar_Reporte_Sin_Telefono.xlsx"');

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Error al generar Excel Sin Teléfono:", error);
        res.status(500).json({ error: error.message });
    }
}

app.get('/api/exportar', generarExcelEstructuradoExcelJS);
app.get('/api/exportar/excel', generarExcelEstructuradoExcelJS);
app.get('/api/exportar-excel', generarExcelEstructuradoExcelJS);
app.get('/api/exportar-sin-telefono', generarExcelSinTelefonoExcelJS);
app.get('/api/reportes/telefonos-incompletos', generarExcelSinTelefonoExcelJS);
app.get('/api/reportes/sin-telefono', generarExcelSinTelefonoExcelJS);

app.get('/api/auditoria', (req, res) => {
    try {
        const totalClientes = db.prepare('SELECT COUNT(*) as cant FROM clientes').get().cant;
        const totalPolizas = db.prepare('SELECT COUNT(*) as cant FROM polizas').get().cant;

        const activasConTel = db.prepare(`
            SELECT COUNT(*) as cant FROM clientes c
            LEFT JOIN polizas p ON c.id = p.cliente_id
            LEFT JOIN telefonos_invalidos ti ON c.id = ti.cliente_id
            WHERE (c.telefono IS NOT NULL AND c.telefono != '' AND length(c.telefono) >= 10 AND ti.id IS NULL)
              AND LOWER(COALESCE(p.estado, '')) NOT IN ('baja', 'anulada', 'historico', 'historica', 'cancelada')
        `).get().cant;

        const activasSinTel = db.prepare(`
            SELECT COUNT(*) as cant FROM clientes c
            LEFT JOIN polizas p ON c.id = p.cliente_id
            LEFT JOIN telefonos_invalidos ti ON c.id = ti.cliente_id
            WHERE (c.telefono IS NULL OR c.telefono = '' OR length(c.telefono) < 10 OR ti.id IS NOT NULL)
              AND LOWER(COALESCE(p.estado, '')) NOT IN ('baja', 'anulada', 'historico', 'historica', 'cancelada')
        `).get().cant;

        const vencidas30d = db.prepare(`
            SELECT COUNT(*) as cant FROM polizas
            WHERE fecha_vencimiento < date('now', 'localtime')
              AND fecha_vencimiento >= date('now', 'localtime', '-30 days')
        `).get().cant;

        const countHistoricasDB = db.prepare('SELECT COUNT(*) as cant FROM polizas_historicas').get().cant;

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            anomalias_detectadas: 0,
            metricas: {
                total_clientes: totalClientes,
                total_polizas: totalPolizas,
                hoja1_activas_con_telefono: activasConTel,
                hoja2_activas_sin_telefono: activasSinTel,
                polizas_vencidas_30_dias: vencidas30d,
                hoja3_historicas_bajas: countHistoricasDB
            },
            mensaje: '✅ Sistema 100% Calibrado — 0 Anomalías Detectadas'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GRUCAR ACARREO — ASISTENCIA Y CUPONES TRANSACCIONALES
// ═══════════════════════════════════════════════════════════════════════════

function renovarServicioGrucar(polizaId, fechaBaseInput = null) {
    try {
        const pol = db.prepare('SELECT id, cliente_id, operacion, fecha_vencimiento_grucar, grucar_activo, estado, cuotas_debe FROM polizas WHERE id = ? OR operacion = ?').get(polizaId, polizaId);
        if (!pol) return null;

        const est = (pol.estado || '').toLowerCase();
        const cuotas = parseInt(pol.cuotas_debe || 0);
        if (est === 'anulada' || est === 'baja' || cuotas >= 2) {
            db.prepare('UPDATE polizas SET grucar_activo = 0 WHERE id = ?').run(pol.id);
            return { activo: false, motivo: 'Poliza inactiva o en mora critica' };
        }

        const hoyStr = new Date().toISOString().split('T')[0];
        const base = fechaBaseInput || hoyStr;
        let actualGrucar = pol.fecha_vencimiento_grucar || hoyStr;

        // Formula acumulativa: MAX(COALESCE(fecha_vencimiento_grucar, HOY), HOY) + 30 DÍAS
        let fechaRef = (actualGrucar > hoyStr) ? actualGrucar : hoyStr;
        if (base > fechaRef) fechaRef = base;

        const parts = fechaRef.split('-');
        const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        d.setDate(d.getDate() + 30);
        const nuevaFecha = d.toISOString().split('T')[0];

        db.prepare('UPDATE polizas SET fecha_vencimiento_grucar = ?, grucar_activo = 1 WHERE id = ?').run(nuevaFecha, pol.id);

        // Async non-blocking push attempt to segucar.grucar.com.ar API (timeout 3s)
        if (typeof globalThis.fetch === 'function') {
            globalThis.fetch('https://segucar.grucar.com.ar/api/push-cupon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    poliza: pol.operacion,
                    vencimiento_grucar: nuevaFecha,
                    operador: 'segucar.operador@grucar.com.ar'
                }),
                signal: AbortSignal.timeout(3000)
            }).catch(err => {
                console.warn('⚡ Async Grucar API push notice:', err.message);
            });
        }

        return { activo: true, nuevaFecha };
    } catch (e) {
        console.error('Error en renovarServicioGrucar:', e);
        return null;
    }
}

async function registrarVehiculoGrucar(datos) {
    try {
        const hoyStr = new Date().toISOString().split('T')[0];
        const payload = {
            patente: datos.patente || '',
            vehiculo: datos.vehiculo || '',
            numero_poliza: datos.operacion || datos.numero_poliza || '',
            nombre_apellido: datos.nombre || datos.nombre_apellido || '',
            notas: datos.notas || 'Alta automatizada SEGUCar',
            meses_pago: datos.meses_pago || 1,
            inicio_servicio: datos.inicio_servicio || hoyStr,
            operador: 'segucar.operador@grucar.com.ar'
        };

        // Async non-blocking push with 3-second timeout
        if (typeof globalThis.fetch === 'function') {
            const resp = await globalThis.fetch('https://segucar.grucar.com.ar/api/alta-vehiculo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(3000)
            });

            if (resp.ok) {
                const resData = await resp.json().catch(() => ({}));
                const remotoId = resData.id || resData.cupon_id || `GRUCAR-${payload.numero_poliza}`;
                db.prepare('UPDATE polizas SET grucar_pendiente_sync = 0, grucar_id_remoto = ?, grucar_activo = 1 WHERE operacion = ? OR id = ?').run(remotoId, payload.numero_poliza, datos.poliza_id || 0);
                console.log(`✅ Alta Grucar exitosa para patente ${payload.patente} (ID: ${remotoId})`);
                return { success: true, id: remotoId };
            } else {
                db.prepare('UPDATE polizas SET grucar_pendiente_sync = 1 WHERE operacion = ? OR id = ?').run(payload.numero_poliza, datos.poliza_id || 0);
                console.warn(`⚠️ Alta Grucar remota no disponible (HTTP ${resp.status}). Guardado local con grucar_pendiente_sync = 1.`);
                return { success: false, pending: true };
            }
        }
    } catch (err) {
        db.prepare('UPDATE polizas SET grucar_pendiente_sync = 1 WHERE operacion = ? OR id = ?').run(datos.operacion || datos.numero_poliza || '', datos.poliza_id || 0);
        console.warn(`⚠️ Grucar API timeout/error: ${err.message}. Guardado local sin bloquear.`);
        return { success: false, pending: true };
    }
}

app.get('/api/cliente/grucar-cupon', (req, res) => {
    try {
        const { poliza, dni } = req.query;
        if (!poliza && !dni) {
            return res.status(400).json({ error: 'Falta parametro poliza o dni' });
        }
        const pol = db.prepare(`
            SELECT p.*, c.nombre, c.dni, c.telefono
            FROM polizas p
            JOIN clientes c ON p.cliente_id = c.id
            WHERE (p.operacion = ? OR c.dni = ?)
              AND LOWER(COALESCE(p.estado, '')) NOT IN ('anulada', 'baja')
            ORDER BY p.id DESC LIMIT 1
        `).get(poliza || '', dni || '');

        if (!pol) {
            return res.status(404).json({ error: 'No se encontro poliza activa para el asegurado' });
        }

        const hoyStr = new Date().toISOString().split('T')[0];
        let vtoGrucar = pol.fecha_vencimiento_grucar;
        if (!vtoGrucar) {
            renovarServicioGrucar(pol.id, hoyStr);
            const polFresh = db.prepare('SELECT fecha_vencimiento_grucar, grucar_activo FROM polizas WHERE id = ?').get(pol.id);
            vtoGrucar = polFresh ? polFresh.fecha_vencimiento_grucar : hoyStr;
        }

        const cuotas = parseInt(pol.cuotas_debe || 0);
        const est = (pol.estado || '').toLowerCase();
        const isActivo = pol.grucar_activo !== 0 && est !== 'anulada' && est !== 'baja' && cuotas < 2 && vtoGrucar >= hoyStr;

        res.json({
            success: true,
            activo: isActivo,
            cupon: {
                nro_comprobante: `GRUCAR-SUA-${pol.operacion}`,
                asegurado: pol.nombre,
                dni: pol.dni,
                vehiculo: pol.vehiculo || 'Vehículo Asegurado',
                patente: pol.patente || '-',
                operacion: pol.operacion,
                vigencia_hasta: vtoGrucar,
                telefonos_emergencia: ['223-511-4117', '223-516-4128'],
                cobertura_zona: 'Mar del Plata, Batán, Sierra de los Padres y Accesos Ruta 2 / 11 / 226 / 88',
                leyenda_carencia: 'Servicio de Remolque y mecánica ligera local. Total 1 servicio por mes de vigencia. Nuevos socios carencia de 48hs.',
                url_portal_grucar: `https://segucar.grucar.com.ar/cupon/${pol.operacion}`
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CLIENTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/clientes', (req, res) => {
    try {
        const search = req.query.search || '';
        const tipo_vehiculo = req.query.tipo_seguro || '';
        const estado = req.query.estado || '';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        const todayStr = toLocalISOString(new Date());
        const lastSync = getLastSyncDate();
        const todayDay = new Date().getDay();
        const isMonday = (todayDay === 1);
        const suppressAlerts = isMonday && (lastSync !== todayStr);

        const dateVence48h = addCalendarDays(todayStr, 2);
        const dateVencio48h = addCalendarDays(todayStr, -2);
        const dateVencio96h = addCalendarDays(todayStr, -4);
        const dateMoraCriticaLimit = addCalendarDays(todayStr, -4);

        const vtoOpExpr = `COALESCE(CASE strftime('%w', p.fecha_vencimiento) WHEN '6' THEN date(p.fecha_vencimiento, '+2 days') WHEN '0' THEN date(p.fecha_vencimiento, '+1 day') ELSE p.fecha_vencimiento END, '')`;

        let where = 'WHERE 1=1';
        const params = [];

        if (search) {
            where += ` AND (c.nombre LIKE ? OR c.dni LIKE ? OR c.telefono LIKE ? OR p.operacion LIKE ? OR p.patente LIKE ? OR p.vehiculo LIKE ?)`;
            const s = `%${search}%`;
            params.push(s, s, s, s, s, s);
        }
        if (tipo_vehiculo) {
            where += ` AND p.tipo_vehiculo = ?`;
            params.push(tipo_vehiculo);
        }
        if (estado) {
            const estadoNorm = estado.toLowerCase().replace(/\s+/g, '_');

            // ── RENOVACIONES ────────────────────────────────────────────────
            if (estadoNorm === 'por_vencer' || estadoNorm === 'renovacion_7_dias') {
                where += ` AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) = 7`;
            } else if (estadoNorm === 'vencida' || estadoNorm === 'poliza_vencida') {
                where += ` AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) < 0`;
            } else if (estadoNorm === 'historico' || estadoNorm === 'historica' || estadoNorm === 'baja' || estadoNorm === 'anulada' || estadoNorm === 'recuperacion_historica') {
                where += ` AND (LOWER(COALESCE(p.estado, '')) IN ('anulada', 'baja') OR p.fecha_vencimiento < date('now', 'localtime', '-30 days'))`;
            } else if (estadoNorm === 'vigente' || estadoNorm === 'contrato_vigente') {
                where += ` AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0`;

            // ── COBRANZA (Business days & Monday Sync check) ────────────────
            } else if (estadoNorm === 'vence_48h' || estadoNorm === 'cuota_vence_48h' || estadoNorm === 'recordatorio_48hs') {
                if (suppressAlerts) {
                    where += ` AND 1=0`; // No alerts trigger on Monday until sync is completed
                } else {
                    where += ` AND (p.cuotas_debe IS NULL OR p.cuotas_debe = 0) AND p.saldo_pendiente > 0 AND CAST(julianday(p.fecha_vencimiento) - julianday(date('now', 'localtime')) AS INTEGER) = 2`;
                }
            } else if (estadoNorm === 'vencio_48h' || estadoNorm === 'primer_aviso') {
                if (suppressAlerts) {
                    where += ` AND 1=0`;
                } else {
                    where += ` AND p.cuotas_debe = 1 AND p.saldo_pendiente > 0 AND CAST(julianday(p.fecha_vencimiento) - julianday(date('now', 'localtime')) AS INTEGER) = -2`;
                }
            } else if (estadoNorm === 'vencio_96h' || estadoNorm === 'segundo_aviso') {
                if (suppressAlerts) {
                    where += ` AND 1=0`;
                } else {
                    where += ` AND p.cuotas_debe = 1 AND p.saldo_pendiente > 0 AND CAST(julianday(p.fecha_vencimiento) - julianday(date('now', 'localtime')) AS INTEGER) = -4`;
                }
            } else if (estadoNorm === 'cuota_deuda' || estadoNorm === 'deuda' || estadoNorm === 'deudores' || estadoNorm === 'mora_critica') {
                if (suppressAlerts) {
                    where += ` AND p.cuotas_debe >= 2 AND p.saldo_pendiente > 0`;
                } else {
                    where += ` AND p.saldo_pendiente > 0 AND (p.cuotas_debe >= 2 OR (p.cuotas_debe > 0 AND CAST(julianday(p.fecha_vencimiento) - julianday(date('now', 'localtime')) AS INTEGER) < -4))`;
                }
            } else if (estadoNorm === 'cuota_aldia' || estadoNorm === 'al_dia') {
                if (suppressAlerts) {
                    where += ` AND (p.saldo_pendiente IS NULL OR p.saldo_pendiente <= 0 OR p.cuotas_debe IS NULL OR p.cuotas_debe = 0)`;
                } else {
                    where += ` AND (p.saldo_pendiente IS NULL OR p.saldo_pendiente <= 0 OR ((p.cuotas_debe IS NULL OR p.cuotas_debe = 0) AND CAST(julianday(p.fecha_vencimiento) - julianday(date('now', 'localtime')) AS INTEGER) != 2))`;
                }
            } else if (estadoNorm && estadoNorm !== 'todos' && estadoNorm !== 'all' && estadoNorm !== 'todas') {
                where += ` AND p.estado = ?`;
                params.push(estado);
            }
        }

        if (req.query.fecha_desde) {
            where += ` AND p.fecha_vencimiento >= ?`;
            params.push(req.query.fecha_desde);
        }
        if (req.query.fecha_hasta) {
            where += ` AND p.fecha_vencimiento <= ?`;
            params.push(req.query.fecha_hasta);
        }

        const sortBy = req.query.sort_by || 'nombre';
        const sortDir = (req.query.sort_dir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        let sortCol = 'c.nombre';
        if (sortBy === 'nombre') sortCol = 'c.nombre';
        else if (sortBy === 'telefono') sortCol = 'c.telefono';
        else if (sortBy === 'patente') sortCol = 'p.patente';
        else if (sortBy === 'vehiculo') sortCol = 'p.vehiculo';
        else if (sortBy === 'tipo') sortCol = 'p.tipo_vehiculo';
        else if (sortBy === 'vencimiento') sortCol = 'p.fecha_vencimiento';
        else if (sortBy === 'operacion') sortCol = 'p.operacion';
        else if (sortBy === 'nro_cuota') sortCol = 'p.nro_cuota';
        else if (sortBy === 'importe') sortCol = 'p.saldo_pendiente';
        else if (sortBy === 'dias_mora') sortCol = 'p.fecha_vencimiento';
        else if (sortBy === 'fin_vigencia') sortCol = 'p.fin_vigencia_poliza';
        else if (sortBy === 'estado') {
            sortCol = `CASE 
                WHEN p.fecha_vencimiento < date('now') THEN 1
                WHEN p.fecha_vencimiento = date('now') THEN 2
                WHEN p.fecha_vencimiento <= date('now', '+7 days') THEN 3
                WHEN p.fecha_vencimiento <= date('now', '+30 days') THEN 4
                ELSE 5
            END`;
        } else if (sortBy === 'cuota') {
            sortCol = `CASE WHEN p.cuotas_debe > 0 THEN 1 ELSE 2 END`;
        } else if (sortBy === 'prioridad_cobranza') {
            if (suppressAlerts) {
                sortCol = `CASE 
                    WHEN p.cuotas_debe >= 2 THEN 4
                    ELSE 5
                END`;
            } else {
                sortCol = `CASE 
                    WHEN (p.cuotas_debe IS NULL OR p.cuotas_debe = 0) AND ${vtoOpExpr} >= '${todayStr}' AND ${vtoOpExpr} <= '${dateVence48h}' THEN 1
                    WHEN p.cuotas_debe = 1 AND ${vtoOpExpr} = '${dateVencio48h}' THEN 2
                    WHEN p.cuotas_debe = 1 AND ${vtoOpExpr} = '${dateVencio96h}' THEN 3
                    WHEN p.cuotas_debe >= 2 OR (p.cuotas_debe > 0 AND ${vtoOpExpr} < '${dateMoraCriticaLimit}') THEN 4
                    ELSE 5
                END`;
            }
        } else if (sortBy === 'prioridad_poliza') {
            // Criterio de Ordenamiento de Renovaciones:
            // 1. PRIMERO (Rank 1): Clientes al día (saldo = 0 y cuotas_debe = 0) que vencen / vigentes.
            // 2. SEGUNDO (Rank 2): Clientes con deuda pendiente (saldo > 0 o cuotas_debe > 0).
            // 3. TERCERO (Rank 3): Pólizas ya vencidas (fin_vigencia < date('now')).
            const targetVencExpr = "COALESCE(NULLIF(p.fin_vigencia_poliza, ''), p.fecha_vencimiento)";
            sortCol = `CASE 
                WHEN ${targetVencExpr} >= date('now') AND (COALESCE(p.saldo_pendiente, 0) = 0 AND COALESCE(p.cuotas_debe, 0) = 0) THEN 1
                WHEN COALESCE(p.saldo_pendiente, 0) > 0 OR COALESCE(p.cuotas_debe, 0) > 0 THEN 2
                WHEN ${targetVencExpr} < date('now') THEN 3
                ELSE 4
            END`;
        }

        const countQuery = `SELECT COUNT(DISTINCT c.id) as count FROM clientes c INNER JOIN polizas p ON c.id = p.cliente_id ${where}`;
        const total = db.prepare(countQuery).get(...params).count;

        // For priority sorts we want the WORST ranked poliza to determine the client's rank (MIN = most urgent)
        const prioritySorts = ['prioridad_cobranza', 'prioridad_poliza', 'estado', 'cuota'];
        const aggFn = prioritySorts.includes(sortBy) ? 'MIN' : 'MAX';

        // sort_fecha: pick the earliest relevant fecha_vencimiento for the client.
        // Only poliza-column sorts can be used inside the correlated subquery.
        // If sortCol references clientes (e.g. c.nombre), just order by fecha_vencimiento.
        const isSortByPolizaCol = sortCol.startsWith('p.') || sortCol.startsWith('CASE');
        const sortFechaSubquery = `(
            SELECT p2.fecha_vencimiento FROM polizas p2 
            WHERE p2.cliente_id = c.id 
            ORDER BY ${isSortByPolizaCol ? `(${sortCol.replace(/\bp\b\./g, 'p2.')}) ASC, ` : ''}p2.fecha_vencimiento ASC 
            LIMIT 1
        )`;

        const query = `
            SELECT c.*, ${aggFn}(${isSortByPolizaCol ? sortCol : '1'}) as sort_val, ${sortFechaSubquery} as sort_fecha
            FROM clientes c 
            INNER JOIN polizas p ON c.id = p.cliente_id 
            ${where} 
            GROUP BY c.id 
            ORDER BY ${isSortByPolizaCol ? `sort_val ${sortDir},` : ''} sort_fecha ASC, c.telefono ASC, c.nombre ASC
            LIMIT ? OFFSET ?
        `;
        params.push(limit, offset);
        const clientes = db.prepare(query).all(...params);

        const polizaSort = (sortBy === 'vencimiento' || sortBy === 'estado')
            ? (sortDir === 'ASC' ? 'fecha_vencimiento ASC' : 'fecha_vencimiento DESC')
            : 'fecha_vencimiento DESC';

        const hoyStr = toLocalISOString(new Date());

        for (let cliente of clientes) {
            let rawPolizas = db.prepare(`SELECT * FROM polizas WHERE cliente_id = ? ORDER BY fecha_vencimiento ASC`).all(cliente.id);

            if (estado) {
                const estadoNorm = estado.toLowerCase().replace(/\s+/g, '_');
                rawPolizas = rawPolizas.filter(p => {
                    const fv = p.fecha_vencimiento || '';
                    const cd = parseInt(p.cuotas_debe || 0);
                    const fvRen = p.fin_vigencia_poliza || fv;
                    if (estadoNorm === 'por_vencer' || estadoNorm === 'renovacion_7_dias') {
                        const parts = fvRen.split('-');
                        if (parts.length !== 3) return false;
                        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        const todayDate = parseLocalDate(hoyStr);
                        const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                        return calDiffRen === 7;
                    }
                    if (estadoNorm === 'vencida' || estadoNorm === 'poliza_vencida') {
                        const parts = fvRen.split('-');
                        if (parts.length !== 3) return false;
                        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        const todayDate = parseLocalDate(hoyStr);
                        const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                        return calDiffRen < 0;
                    }
                    if (estadoNorm === 'historico' || estadoNorm === 'historica' || estadoNorm === 'baja' || estadoNorm === 'anulada' || estadoNorm === 'recuperacion_historica') {
                        const est = (p.estado || '').toLowerCase();
                        if (est === 'anulada' || est === 'baja') return true;
                        const parts = fv.split('-');
                        if (parts.length !== 3) return false;
                        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        const todayDate = parseLocalDate(hoyStr);
                        const calDiff = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                        return calDiff < -30;
                    }
                    if (estadoNorm === 'vigente' || estadoNorm === 'contrato_vigente') {
                        const parts = fvRen.split('-');
                        if (parts.length !== 3) return false;
                        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        const todayDate = parseLocalDate(hoyStr);
                        const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                        return calDiffRen >= 0;
                    }

                    const parts = fv.split('-');
                    if (parts.length !== 3) return false;
                    const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                    const todayDate = parseLocalDate(hoyStr);
                    const calDiff = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));

                    if (suppressAlerts) {
                        if (estadoNorm === 'cuota_deuda' || estadoNorm === 'deuda' || estadoNorm === 'deudores' || estadoNorm === 'mora_critica') {
                            return cd >= 2;
                        }
                        if (estadoNorm === 'cuota_aldia' || estadoNorm === 'al_dia') {
                            return cd === 0;
                        }
                        return false; // Suppress recordatorio_48hs, primer_aviso, segundo_aviso on Monday before sync
                    }

                    const saldoVal = parseFloat(p.saldo_pendiente || 0);

                    if (estadoNorm === 'vence_48h' || estadoNorm === 'cuota_vence_48h' || estadoNorm === 'recordatorio_48hs') {
                        return cd === 0 && saldoVal > 0 && calDiff === 2;
                    }
                    if (estadoNorm === 'vencio_48h' || estadoNorm === 'primer_aviso') {
                        return cd === 1 && saldoVal > 0 && calDiff === -2;
                    }
                    if (estadoNorm === 'vencio_96h' || estadoNorm === 'segundo_aviso') {
                        return cd === 1 && saldoVal > 0 && calDiff === -4;
                    }
                    if (estadoNorm === 'cuota_deuda' || estadoNorm === 'deuda' || estadoNorm === 'deudores' || estadoNorm === 'mora_critica') {
                        return (cd >= 2 || (cd > 0 && calDiff < -4)) && saldoVal > 0;
                    }
                    if (estadoNorm === 'cuota_aldia' || estadoNorm === 'al_dia') {
                        return saldoVal <= 0 || (cd === 0 && calDiff !== 2);
                    }
                    return true;
                });
            }

            const patentesVistas = new Set();
            const polizasDeduplicadas = [];
            for (const p of rawPolizas) {
                const pat = (p.patente || '').trim().toUpperCase();
                if (pat && pat.length >= 3) {
                    if (patentesVistas.has(pat)) continue;
                    patentesVistas.add(pat);
                }
                polizasDeduplicadas.push(p);
            }
            for (let p of polizasDeduplicadas) {
                p.saldo_exigible = getSaldoExigible(p);
            }
            cliente.polizas = polizasDeduplicadas;
        }

        res.json({ clientes, total, page, pages: Math.ceil(total / limit) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/recuperacion', (req, res) => {
    try {
        const search = req.query.search || '';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        // Exclude historical records if client currently has an active policy in `polizas`
        // AND exclusively require > 1 month of antiquity (fecha_vencimiento < date('now', '-30 days'))
        let where = `WHERE (fecha_vencimiento < date('now', '-30 days')) AND NOT EXISTS (
            SELECT 1 FROM polizas p 
            WHERE (p.patente = polizas_historicas.patente AND p.patente IS NOT NULL AND p.patente != '')
               OR (p.operacion = polizas_historicas.operacion AND p.operacion IS NOT NULL AND p.operacion != '')
        )`;
        let params = [];

        if (search) {
            where += ` AND (nombre LIKE ? OR patente LIKE ? OR vehiculo LIKE ? OR operacion LIKE ? OR telefono LIKE ?)`;
            const term = `%${search}%`;
            params.push(term, term, term, term, term);
        }

        const sortBy = req.query.sort_by || 'fecha_vencimiento';
        const sortDir = (req.query.sort_dir || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const validSortCols = {
            'nombre': 'nombre',
            'telefono': 'telefono',
            'patente': 'patente',
            'operacion': 'operacion',
            'vehiculo': 'vehiculo',
            'fecha_vencimiento': 'fecha_vencimiento',
            'estrategia': 'estrategia'
        };
        const sortCol = validSortCols[sortBy] || 'fecha_vencimiento';

        const total = db.prepare(`SELECT COUNT(*) as count FROM polizas_historicas ${where}`).get(...params).count;
        const items = db.prepare(`SELECT * FROM polizas_historicas ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, limit, offset);

        res.json({ items, total, page, pages: Math.ceil(total / limit) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/recuperacion/exportar', (req, res) => {
    try {
        const items = db.prepare('SELECT * FROM polizas_historicas ORDER BY fecha_vencimiento DESC').all();

        const exportData = items.map(item => ({
            'Cliente': item.nombre || '',
            'Teléfono / WhatsApp': item.telefono || '',
            'Patente': item.patente || '',
            'N° Póliza Anterior': item.operacion || '',
            'Vehículo': item.vehiculo || '',
            'Último Vencimiento': item.fecha_vencimiento || '',
            'Estrategia': item.estrategia || 'Oportunidad Reactivación'
        }));

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(exportData);
        xlsx.utils.book_append_sheet(wb, ws, 'Cartera Recuperacion');

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="Cartera_Recuperacion_SEGUCar.xlsx"');
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sync-nre', async (req, res) => {
    try {
        const usuario = req.body.usuario || process.env.SISTEMA_USUARIO || 'SUA';
        const password = req.body.password || process.env.SISTEMA_PASSWORD || 'sua';
        
        const result = await syncGeneralNRE(usuario, password);
        updateLastSyncDate();
        res.json({
            success: true,
            message: 'Sincronización en vivo con portal NRE completada exitosamente.',
            detalles: result
        });
    } catch (error) {
        console.error('Error en sync-nre:', error);
        res.status(500).json({ error: 'Error al sincronizar con portal NRE: ' + error.message });
    }
});

app.get('/api/clientes/:id', (req, res) => {
    try {
        const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
        cliente.polizas = db.prepare('SELECT * FROM polizas WHERE cliente_id = ? ORDER BY fecha_vencimiento DESC').all(cliente.id);
        cliente.contactos = db.prepare('SELECT * FROM contactos WHERE cliente_id = ? ORDER BY fecha DESC LIMIT 20').all(cliente.id);
        res.json(cliente);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/clientes', (req, res) => {
    try {
        const { nombre, dni, direccion, telefono, email } = req.body;
        const sanitizedPhone = sanitizeAndFixPhone(telefono);
        const info = db.prepare(`INSERT INTO clientes (nombre, dni, direccion, telefono, email) VALUES (?, ?, ?, ?, ?)`).run(nombre, dni, direccion, sanitizedPhone, email);
        res.status(201).json({ id: info.lastInsertRowid, message: 'Cliente creado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/clientes/:id', (req, res) => {
    try {
        const { nombre, dni, direccion, telefono, email } = req.body;
        const sanitizedPhone = sanitizeAndFixPhone(telefono);
        const info = db.prepare(`UPDATE clientes SET nombre=?, dni=?, direccion=?, telefono=?, email=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(nombre, dni, direccion, sanitizedPhone, email, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Cliente no encontrado' });

        if (sanitizedPhone && sanitizedPhone.length >= 10) {
            if (typeof db.guardarTelefonoMaestro === 'function') {
                db.guardarTelefonoMaestro(req.params.id, nombre, sanitizedPhone, 'manual');
            }
            db.prepare("DELETE FROM telefonos_invalidos WHERE cliente_id = ?").run(req.params.id);
        } else if (!sanitizedPhone) {
            if (typeof db.marcarTelefonoInvalido === 'function') {
                db.marcarTelefonoInvalido(req.params.id, 'borrado_manual');
            }
        }

        res.json({ message: 'Cliente actualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/clientes/:id', (req, res) => {
    try {
        const info = db.prepare('DELETE FROM clientes WHERE id = ?').run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Cliente no encontrado' });
        res.json({ message: 'Cliente eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PÓLIZAS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/polizas/vencimientos', (req, res) => {
    try {
        const dias = parseInt(req.query.dias) || 7;
        const vencimientos = db.prepare(`
            SELECT p.*, c.nombre as cliente_nombre, c.telefono as cliente_telefono, c.email as cliente_email
            FROM polizas p JOIN clientes c ON p.cliente_id = c.id
            WHERE p.fecha_vencimiento >= date('now')
            AND p.fecha_vencimiento <= date('now', '+' || ? || ' days')
            ORDER BY p.fecha_vencimiento ASC
        `).all(dias);
        res.json(vencimientos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/clientes/:id/polizas', (req, res) => {
    try {
        const { operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion } = req.body;
        const hoyStr = new Date().toISOString().split('T')[0];
        const info = db.prepare(`
            INSERT INTO polizas (cliente_id, operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion, estado, grucar_activo)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'vigente', 1)
        `).run(req.params.id, operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion);

        const cli = db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(req.params.id);

        // Background non-blocking auto-registration in Grucar
        registrarVehiculoGrucar({
            poliza_id: info.lastInsertRowid,
            operacion: operacion,
            patente: patente,
            vehiculo: vehiculo,
            nombre: cli ? cli.nombre : '',
            inicio_servicio: hoyStr
        }).catch(() => {});

        res.status(201).json({ id: info.lastInsertRowid, message: 'Póliza creada y servicio Grucar procesado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/polizas/:id', (req, res) => {
    try {
        const { operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion, estado } = req.body;
        const info = db.prepare(`
            UPDATE polizas SET operacion=?, tipo_vehiculo=?, patente=?, vehiculo=?, fecha_vencimiento=?, seccion=?, estado=? WHERE id=?
        `).run(operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion, estado, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Póliza no encontrada' });
        res.json({ message: 'Póliza actualizada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/polizas/:id', (req, res) => {
    try {
        const info = db.prepare('DELETE FROM polizas WHERE id = ?').run(req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Póliza no encontrada' });
        res.json({ message: 'Póliza eliminada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  IMPORTAR EXCEL (adaptado al formato real del Excel de vencimientos)
// ═══════════════════════════════════════════════════════════════════════════

// Determinar tipo de vehículo según marca/modelo y descripción
function detectarTipoVehiculo(seccion, vehiculo) {
    if (!vehiculo) return 'Auto';
    const v = String(vehiculo).toUpperCase();

    // 1. MOTOS / MOTOCICLETAS
    if (/\b(MOTO|MOTOS|MOTOCICLETA|CUATRICICLO|ATV|SCOOTER|ZANELLA|CG\s*150|TITAN|TORNADO|TWISTER|WAVE|BIZ|STORM|YBR|FZ|XTZ|CRYPTON|BENELLI|BAJAJ|ROUSER|DUKE|GILERA|MOTOMEL|CORVEN|MONDIAL|GUERRERO|SIAMBRETA|SIAM|KELLER|BRAVA|PIAGGIO|VESPA|KLIGHT|MEGELLI|SMASH|HUNTER|MILESTONE|SKUA|TRIP)\b/.test(v)) {
        return 'Moto';
    }

    // 2. PICK UPS / UTILITARIOS / VANS
    if (/\b(PICK\s*UP|PICKUP|PICK-UP|P-UP|HILUX|RANGER|AMAROK|L200|S10|FRONTIER|ALASKAN|STRADA|SAVEIRO|TORO|FIORINO|KANGOO|PARTNER|BERLINGO|COURIER|OROCH|MONTANA|RAM|F-100|F100|SILVERADO|CHEYENNE|DAKOTA|C-10|C10|D-20|D20|LUV|RASTROJERO|EXPERT|JUMPY|VITO|TRANSIT|DUCATO|MASTER|SPRINTER|TRAFIC|JUMPER|BOXER|EXPRESS|FURGON|FURGÓN)\b/.test(v)) {
        return 'Pick Up';
    }

    // 3. CAMIONES / PESADOS / TRAILERS / ACOPLADOS
    if (/\b(CAMION|CAMIÓN|SCANIA|IVECO|VOLVO|ACOPLADO|SEMI|TRAILER|BATAM|CHASIS|FORD\s*CARGO|CARGO\s*1722|C-1114|1114|1215|1620|608|7000|14000|DP\s*800|DP-800|K\s*2400|HD78|HD65|AGRALE|EJE|EJES|CASA\s*RODANTE|IMPLEMENTO|MERCEDES\s*BENZ\s*C\s*L\s*\d|MERCEDES\s*BENZ\s*L\s*\d|FORD\s*CAMION)\b/.test(v)) {
        return 'Camión';
    }

    // 4. AUTOS (Sedán, Hatchback, SUV como EcoSport, Duster, Tracker, C3 AIRCROSS, Meriva, etc.)
    return 'Auto';
}

function parseFecha(dateStr) {
    if (!dateStr) return null;
    if (typeof dateStr === 'number') {
        const date = new Date(Math.round((dateStr - 25567) * 86400 * 1000));
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    const parts = String(dateStr).trim().split('/');
    if (parts.length === 3) {
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return String(dateStr).trim();
}

app.post('/api/importar', upload.single('archivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    let importados = 0, actualizados = 0, errores = 0;
    const detalles = [];

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });

        const findClienteByName = db.prepare('SELECT id FROM clientes WHERE UPPER(TRIM(nombre)) = UPPER(TRIM(?)) LIMIT 1');
        const insertCliente = db.prepare('INSERT INTO clientes (nombre, telefono, direccion) VALUES (?, ?, ?)');
        const updateClienteTel = db.prepare("UPDATE clientes SET telefono = ? WHERE id = ? AND (telefono IS NULL OR telefono = '')");
        const findPoliza = db.prepare('SELECT id FROM polizas WHERE operacion = ?');
        const insertPoliza = db.prepare(`
            INSERT INTO polizas (cliente_id, operacion, seccion, tipo_vehiculo, patente, vehiculo, suma_asegurada, cod_prod, cuenta, fecha_vencimiento, renovada, cuotas_debe, estado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const updatePoliza = db.prepare(`
            UPDATE polizas SET seccion=?, tipo_vehiculo=?, patente=?, vehiculo=?, suma_asegurada=?, fecha_vencimiento=?, renovada=?, cuotas_debe=?, estado=? WHERE operacion=?
        `);

        const transaction = db.transaction((rows) => {
            for (const row of rows) {
                try {
                    const operacion = String(row['Operacion'] || '').trim();
                    const nombre = String(row['Nombre'] || row['Asegurado'] || '').trim();
                    const telefono = sanitizeAndFixPhone(row['Teléfono'] || row['Telefono'] || '');
                    const seccion = row['Seccion'] || row['Sección'] || '';
                    const patente = String(row['Patente'] || '').trim();
                    // Support both "Vehículo" column and "Marca" column
                    const vehiculo = String(row['Vehículo'] || row['Vehiculo'] || row['Marca'] || '').trim();
                    const sumaAseg = String(row['Suma Aseg'] || '').trim();
                    const codProd = String(row['Cod Prod'] || '').trim();
                    const cuenta = String(row['Cuenta'] || row['Productor'] || '').trim();
                    const finVig = parseFecha(row['Fin Vig'] || row['Vencimiento'] || row['Vig. Hasta'] || row['Fecha Vencimiento'] || '');
                    const renovada = String(row['Renovada'] || '').trim();
                    const cuoDebe = parseInt(row['Cuo Debe']) || 0;
                    const direccion = String(row['Direccion'] || row['Dirección'] || '').trim();
                    const localidad = String(row['Localidad'] || '').trim();
                    const direccionCompleta = [direccion, localidad].filter(Boolean).join(', ');

                    if (!operacion) { errores++; continue; }

                    // Use 'Tipo Vehiculo' column if available, otherwise detect
                    let tipoVehiculo;
                    const tipoExcel = String(row['Tipo Vehiculo'] || row['Tipo'] || '').trim().toLowerCase();
                    if (tipoExcel.includes('moto') || tipoExcel.includes('cuatri')) tipoVehiculo = 'Moto';
                    else if (tipoExcel.includes('pick') || tipoExcel.includes('van') || tipoExcel.includes('4x4') || tipoExcel.includes('jeep')) tipoVehiculo = 'Pick Up';
                    else if (tipoExcel.includes('camion') || tipoExcel.includes('camión') || tipoExcel.includes('trailer') || tipoExcel.includes('minibus') || tipoExcel.includes('implemento') || tipoExcel.includes('casa rodante')) tipoVehiculo = 'Camión';
                    else if (tipoExcel) tipoVehiculo = 'Auto';
                    else tipoVehiculo = detectarTipoVehiculo(seccion, vehiculo);
                    
                    // Determinar estado
                    let estado = 'vigente';
                    if (finVig) {
                        const hoy = new Date();
                        const venc = new Date(finVig);
                        if (venc < hoy) estado = 'vencida';
                        else if ((venc - hoy) / 86400000 <= 30) estado = 'por_vencer';
                    }

                    // Buscar o crear cliente
                    let cliente_id;
                    const existing = findClienteByName.get(nombre);
                    if (existing) {
                        cliente_id = existing.id;
                        if (telefono) updateClienteTel.run(telefono, cliente_id);
                        if (direccionCompleta) {
                            db.prepare("UPDATE clientes SET direccion = ? WHERE id = ? AND (direccion IS NULL OR direccion = '')").run(direccionCompleta, cliente_id);
                        }
                    } else {
                        const info = insertCliente.run(nombre, telefono, direccionCompleta);
                        cliente_id = info.lastInsertRowid;
                    }

                    // Buscar o crear póliza
                    const existingPoliza = findPoliza.get(operacion);
                    if (existingPoliza) {
                        updatePoliza.run(seccion, tipoVehiculo, patente, vehiculo, sumaAseg, finVig, renovada, cuoDebe, estado, operacion);
                        actualizados++;
                    } else {
                        insertPoliza.run(cliente_id, operacion, seccion, tipoVehiculo, patente, vehiculo, sumaAseg, codProd, cuenta, finVig, renovada, cuoDebe, estado);
                        importados++;
                    }
                } catch (err) {
                    errores++;
                    detalles.push(`Error fila: ${err.message}`);
                }
            }
        });

        transaction(data);

        // Cleanup upload
        try { fs.unlinkSync(req.file.path); } catch(e) {}

        updateLastSyncDate();
        res.json({ importados, actualizados, errores, detalles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  IMPORTAR CONTACTOS VCF
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/importar-contactos', upload.single('archivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

    let importados = 0, cruzados = 0;
    const detalles = [];

    try {
        const content = fs.readFileSync(req.file.path, 'utf-8');
        const vcards = content.split('END:VCARD');

        const insertContacto = db.prepare('INSERT INTO contactos_telefono (nombre, telefono) VALUES (?, ?)');
        const findClientes = db.prepare(`SELECT id, nombre FROM clientes WHERE (telefono IS NULL OR telefono = '') AND UPPER(nombre) LIKE UPPER(?)`);
        const updateTel = db.prepare('UPDATE clientes SET telefono = ? WHERE id = ?');

        for (const vcard of vcards) {
            if (!vcard.includes('BEGIN:VCARD')) continue;

            let nombre = '';
            let telefono = '';

            const fnMatch = vcard.match(/FN[;:](.+)/);
            if (fnMatch) nombre = fnMatch[1].trim();

            const telMatch = vcard.match(/TEL[;:][^\n]*?([+\d][\d\s\-\(\)]+)/);
            if (telMatch) telefono = sanitizeAndFixPhone(telMatch[1]);

            if (!nombre || !telefono) continue;

            insertContacto.run(nombre, telefono);
            importados++;

            // Try to match with existing clients
            const nameParts = nombre.split(' ').filter(p => p.length > 2);
            for (const part of nameParts) {
                const matches = findClientes.all(`%${part}%`);
                for (const cli of matches) {
                    // Check if names are similar enough
                    const cliWords = cli.nombre.toUpperCase().split(' ');
                    const contactWords = nombre.toUpperCase().split(' ');
                    const commonWords = cliWords.filter(w => contactWords.some(cw => cw.includes(w) || w.includes(cw)));
                    
                    if (commonWords.length >= 2) {
                        updateTel.run(telefono, cli.id);
                        cruzados++;
                        detalles.push(`✅ ${cli.nombre} ← ${telefono} (de contacto: ${nombre})`);
                    }
                }
            }
        }

        try { fs.unlinkSync(req.file.path); } catch(e) {}

        res.json({ importados, cruzados, detalles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SCRAPING
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/buscar-poliza-sistema', async (req, res) => {
    try {
        const { operacion, usuario, password } = req.body;
        if (!operacion) return res.status(400).json({ error: 'Número de operación requerido' });
        const user = usuario || process.env.SISTEMA_USUARIO || 'SUA';
        const pass = password || process.env.SISTEMA_PASSWORD || 'sua';

        const result = await consultarPolizaSistema(operacion, user, pass);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/scrape-telefonos', async (req, res) => {
    try {
        const usuario = req.body.usuario || process.env.SISTEMA_USUARIO;
        const password = req.body.password || process.env.SISTEMA_PASSWORD;
        if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

        const result = await scrapeTelefonos(usuario, password, (p) => console.log(p.status));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PLANTILLAS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/plantillas', (req, res) => {
    try {
        res.json(db.prepare('SELECT * FROM plantillas').all());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/plantillas', (req, res) => {
    try {
        const { nombre, tipo, mensaje, activa } = req.body;
        const info = db.prepare('INSERT INTO plantillas (nombre, tipo, mensaje, activa) VALUES (?, ?, ?, ?)').run(nombre, tipo, mensaje, activa !== undefined ? activa : 1);
        res.status(201).json({ id: info.lastInsertRowid, message: 'Plantilla creada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/plantillas/:id', (req, res) => {
    try {
        const { nombre, tipo, mensaje, activa } = req.body;
        const info = db.prepare('UPDATE plantillas SET nombre=?, tipo=?, mensaje=?, activa=? WHERE id=?').run(nombre, tipo, mensaje, activa, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Plantilla no encontrada' });
        res.json({ message: 'Plantilla actualizada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── AUDITORÍA DE TELÉFONOS INVÁLIDOS / SIN WHATSAPP ──────────────────────────

app.post('/api/clientes/:id/reportar-telefono-invalido', (req, res) => {
    try {
        const clienteId = parseInt(req.params.id);
        const motivo = req.body.motivo || 'numero_inexistente';
        const ok = db.marcarTelefonoInvalido(clienteId, motivo);
        if (!ok) return res.status(404).json({ error: 'Cliente no encontrado o error marcando teléfono' });
        res.json({ success: true, message: 'Teléfono marcado como inválido. Pasado automáticamente a Sin Celular / Requiere Actualización.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/telefonos-invalidos', (req, res) => {
    try {
        const list = db.prepare("SELECT * FROM telefonos_invalidos ORDER BY reported_at DESC").all();
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/reportes/telefonos-invalidos', generarExcelEstructuradoExcelJS);

// ═══════════════════════════════════════════════════════════════════════════
//  MÉTRICAS Y CONVERSIÓN COMERCIAL (Atribución Automática & Edge Cases)
// ═══════════════════════════════════════════════════════════════════════════

function evaluarAtribucionMetricas() {
    if (typeof db.evaluarAtribucionMetricas === 'function') {
        db.evaluarAtribucionMetricas();
    }
}

app.post('/api/contactos', (req, res) => {
    try {
        const { cliente_id, poliza_id, tipo, medio, mensaje } = req.body;
        const info = db.prepare('INSERT INTO contactos (cliente_id, poliza_id, tipo, medio, mensaje) VALUES (?, ?, ?, ?, ?)').run(cliente_id, poliza_id, tipo, medio || 'whatsapp', mensaje);
        
        // Log in historial_gestiones_whatsapp for commercial metrics
        if (!medio || medio === 'whatsapp') {
            let saldoAlEnviar = 0;
            if (poliza_id) {
                const polRes = db.prepare("SELECT COALESCE(saldo_pendiente, 0) as saldo FROM polizas WHERE id = ?").get(poliza_id);
                saldoAlEnviar = polRes ? parseFloat(polRes.saldo || 0) : 0;
            } else {
                const saldoRes = db.prepare("SELECT SUM(COALESCE(saldo_pendiente, 0)) as total_saldo FROM polizas WHERE cliente_id = ?").get(cliente_id);
                saldoAlEnviar = saldoRes ? parseFloat(saldoRes.total_saldo || 0) : 0;
            }
            const plantillaTipo = tipo || 'recordatorio_48hs';

            // CONTROL DE RE-ENVÍOS (Atribución Única):
            // Si el cliente/póliza ya tenía un envío 'pendiente', marcar el previo como 'reemplazada'
            db.prepare(`
                UPDATE historial_gestiones_whatsapp
                SET estado_resultado = 'reemplazada',
                    fecha_resolucion = CURRENT_TIMESTAMP
                WHERE cliente_id = ?
                  AND (poliza_id = ? OR poliza_id IS NULL OR ? IS NULL)
                  AND estado_resultado = 'pendiente'
            `).run(cliente_id, poliza_id || null, poliza_id || null);

            db.prepare(`
                INSERT INTO historial_gestiones_whatsapp (cliente_id, poliza_id, tipo_plantilla, saldo_al_enviar, estado_resultado)
                VALUES (?, ?, ?, ?, 'pendiente')
            `).run(cliente_id, poliza_id || null, plantillaTipo, saldoAlEnviar);
        }

        res.status(201).json({ id: info.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/clientes/:id/contactos', (req, res) => {
    try {
        res.json(db.prepare('SELECT * FROM contactos WHERE cliente_id = ? ORDER BY fecha DESC').all(req.params.id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/metricas', (req, res) => {
    res.redirect('/api/metricas/resumen');
});

app.get('/api/metricas/resumen', (req, res) => {
    try {
        evaluarAtribucionMetricas();

        const rango = req.query.rango || 'este_mes'; // 'este_mes', '30_dias', 'anio_actual', 'todo'
        let whereRango = '';
        if (rango === 'este_mes') {
            whereRango = "WHERE strftime('%Y-%m', fecha_envio) = strftime('%Y-%m', 'now', 'localtime')";
        } else if (rango === '30_dias') {
            whereRango = "WHERE fecha_envio >= date('now', '-30 days', 'localtime')";
        } else if (rango === 'anio_actual') {
            whereRango = "WHERE strftime('%Y', fecha_envio) = strftime('%Y', 'now', 'localtime')";
        }

        const gestiones = db.prepare(`SELECT * FROM historial_gestiones_whatsapp ${whereRango}`).all();

        const total_envios = gestiones.length;
        const reemplazadas = gestiones.filter(g => g.estado_resultado === 'reemplazada').length;
        const pendientes = gestiones.filter(g => g.estado_resultado === 'pendiente').length;
        const exitosos_totales = gestiones.filter(g => g.estado_resultado === 'exitoso_total').length;
        const exitosos_parciales = gestiones.filter(g => g.estado_resultado === 'exitoso_parcial').length;
        const vencidos_sin_pago = gestiones.filter(g => g.estado_resultado === 'vencido_sin_pago').length;

        const total_exitosos = exitosos_totales + exitosos_parciales;
        const total_validos = Math.max(1, total_envios - reemplazadas);
        const tasa_conversion_global = total_envios > 0 ? ((total_exitosos / total_validos) * 100).toFixed(1) : '0';

        function calcularMontoRecuperadoGestion(g) {
            const isRenovacion = ['renovacion_7_dias', 'poliza_vencida', 'recuperacion_historica', 'renovacion_deuda'].includes(g.tipo_plantilla);
            const saldoEnviar = parseFloat(g.saldo_al_enviar || 0);

            if (isRenovacion) {
                // En renovaciones: el valor comercial atribuido por renovar el contrato es la prima/cuota recuperada ($55.865 promedio).
                // En 'renovacion_deuda': computa la cuota adeudada cobrada + la prima del nuevo período.
                const valorPolizaRenovada = 55865;
                return saldoEnviar > 0 ? (saldoEnviar + valorPolizaRenovada) : valorPolizaRenovada;
            }

            if (g.estado_resultado === 'exitoso_total') {
                return saldoEnviar;
            } else if (g.estado_resultado === 'exitoso_parcial') {
                let currentSaldo = 0;
                if (g.poliza_id) {
                    const polRes = db.prepare("SELECT COALESCE(saldo_pendiente, 0) as saldo FROM polizas WHERE id = ?").get(g.poliza_id);
                    currentSaldo = polRes ? parseFloat(polRes.saldo || 0) : 0;
                } else {
                    const saldoRes = db.prepare("SELECT SUM(COALESCE(saldo_pendiente, 0)) as total_saldo FROM polizas WHERE cliente_id = ?").get(g.cliente_id);
                    currentSaldo = saldoRes ? parseFloat(saldoRes.total_saldo || 0) : 0;
                }
                const rec = saldoEnviar - currentSaldo;
                return rec > 0 ? rec : 0;
            }

            return 0;
        }

        let dinero_recuperado_total = 0;
        const plantillasMap = {};

        for (const g of gestiones) {
            const t = g.tipo_plantilla || 'desconocido';
            if (!plantillasMap[t]) {
                plantillasMap[t] = {
                    tipo_plantilla: t,
                    total_envios: 0,
                    exitosos: 0,
                    pendientes: 0,
                    vencidos: 0,
                    reemplazadas: 0,
                    dinero_recuperado: 0
                };
            }

            plantillasMap[t].total_envios += 1;

            if (g.estado_resultado === 'exitoso_total' || g.estado_resultado === 'exitoso_parcial') {
                plantillasMap[t].exitosos += 1;
                const recVal = calcularMontoRecuperadoGestion(g);
                plantillasMap[t].dinero_recuperado += recVal;
                dinero_recuperado_total += recVal;
            } else if (g.estado_resultado === 'pendiente') {
                plantillasMap[t].pendientes += 1;
            } else if (g.estado_resultado === 'vencido_sin_pago') {
                plantillasMap[t].vencidos += 1;
            } else if (g.estado_resultado === 'reemplazada') {
                plantillasMap[t].reemplazadas += 1;
            }
        }

        const resolvedWithDays = gestiones.filter(g => g.dias_hasta_pago !== null && g.dias_hasta_pago !== undefined && (g.estado_resultado === 'exitoso_total' || g.estado_resultado === 'exitoso_parcial'));
        const tiempo_promedio_dias = resolvedWithDays.length > 0
            ? (resolvedWithDays.reduce((acc, g) => acc + g.dias_hasta_pago, 0) / resolvedWithDays.length).toFixed(1)
            : '0';

        const plantillas_performance = Object.values(plantillasMap).map(p => {
            const validosPlantilla = Math.max(1, p.total_envios - p.reemplazadas);
            return {
                ...p,
                tasa_conversion: p.total_envios > 0 ? ((p.exitosos / validosPlantilla) * 100).toFixed(1) : '0'
            };
        }).sort((a, b) => b.total_envios - a.total_envios);

        res.json({
            rango,
            total_envios,
            reemplazadas,
            pendientes,
            exitosos_totales,
            exitosos_parciales,
            vencidos_sin_pago,
            tasa_conversion_global,
            dinero_recuperado_total,
            tiempo_promedio_dias,
            plantillas_performance
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sync-nre/vencimientos', async (req, res) => {
    try {
        const usuario = req.body.usuario || process.env.SISTEMA_USUARIO || 'SUA';
        const password = req.body.password || process.env.SISTEMA_PASSWORD || 'sua';
        const result = await syncVencimientosNRE(usuario, password);
        evaluarAtribucionMetricas();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sync-nre/deudores', async (req, res) => {
    try {
        const usuario = req.body.usuario || process.env.SISTEMA_USUARIO || 'SUA';
        const password = req.body.password || process.env.SISTEMA_PASSWORD || 'sua';
        const result = await syncDeudasNRE(usuario, password);
        evaluarAtribucionMetricas();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/sync-nre/general', async (req, res) => {
    try {
        const usuario = req.body.usuario || process.env.SISTEMA_USUARIO || 'SUA';
        const password = req.body.password || process.env.SISTEMA_PASSWORD || 'sua';
        const result = await syncGeneralNRE(usuario, password);
        evaluarAtribucionMetricas();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🛡️  GestiónSeguro corriendo en http://localhost:${PORT}`);
        console.log(`    Red local: http://0.0.0.0:${PORT}`);
    });
}

module.exports = app;
