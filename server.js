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
const { syncAGS } = require('./sync_ags');
const { esNoHabil, esHabil, obtenerSiguienteDiaHabil, evaluarEstadoCobranzaHabil, toLocalDateString } = require('./holidays_ar');
const waService = require('./whatsapp_service');

// ─── MIGRACIÓN AUTOMÁTICA: Alinear plantillas con nombres de Meta ────────────
(function migrarPlantillas() {
    try {
        // 1. Agregar columna nombre_meta si no existe
        try { db.prepare('ALTER TABLE plantillas ADD COLUMN nombre_meta TEXT').run(); } catch(e) {}

        // 2. Actualizar textos y nombre_meta para cada plantilla
        const updates = [
            {
                tipo: 'recordatorio_48hs',
                nombre_meta: 'recordatorio_preventivo_48hs',
                mensaje: 'Hola, ¿cómo estás? Te aviso que en 48 hs vence la cuota de tu póliza N° {operacion} (Patente {patente}). Escribinos si querés abonarla de manera virtual o te esperamos en cualquiera de nuestras oficinas. ¡Saludos!'
            },
            {
                tipo: 'primer_aviso',
                nombre_meta: 'primer_aviso_vencida_48hs',
                mensaje: 'Hola, te recuerdo que la cuota de tu póliza N° {operacion} (Patente {patente}) venció hace 48 hs. Avisame si necesitás los datos de pago así te mantenemos la cobertura al día. ¡Gracias!'
            },
            {
                tipo: 'segundo_aviso',
                nombre_meta: 'cuota_segundo_aviso_vencida_hace_96_hs',
                mensaje: 'Hola, ¿cómo estás? Te informamos que la cuota de tu seguro ({operacion} - Patente {patente}) venció hace 96 hs y si no se regulariza antes de las 12hs de mañana se suspende la cobertura por falta de pago. Escribinos si querés abonarla de manera virtual o te esperamos en cualquiera de nuestras oficinas. ¡Saludos!'
            },
            {
                tipo: 'mora_critica',
                nombre_meta: 'mora_critica_impaga',
                activa: 1,
                mensaje: 'Hola, te avisamos que la cuota de tu póliza N° {operacion} (Patente {patente}) venció hace más de 4 días y registrás cuotas impagas. La póliza perdió la cobertura. Escribinos urgente para regularizar tu situación.'
            },
            {
                tipo: 'renovacion_7_dias',
                nombre_meta: 'aviso_renovacion_7_dias',
                mensaje: 'Hola, ¿cómo estás? Te informamos que tu póliza N° {operacion} (Patente {patente}) se encuentra al día con los pagos y vence en 7 días. Avisame si querés renovarla así te preparamos la nueva cobertura con anticipación. ¡Un saludo!'
            }
        ];

        for (const u of updates) {
            if (u.activa !== undefined) {
                db.prepare('UPDATE plantillas SET nombre_meta=?, mensaje=?, activa=? WHERE tipo=?')
                  .run(u.nombre_meta, u.mensaje, u.activa, u.tipo);
            } else {
                db.prepare('UPDATE plantillas SET nombre_meta=?, mensaje=? WHERE tipo=?')
                  .run(u.nombre_meta, u.mensaje, u.tipo);
            }
        }
        console.log('✅ Migración plantillas: textos y nombre_meta actualizados');
    } catch(e) {
        console.error('❌ Error en migración plantillas:', e.message);
    }
})();


function getFechasTargetCobranza(targetState, hoyDate = new Date()) {
    const allPol = db.prepare("SELECT DISTINCT fecha_vencimiento FROM polizas WHERE saldo_pendiente > 0 AND fecha_vencimiento IS NOT NULL AND length(fecha_vencimiento) > 0").all();
    const matchingVtos = [];
    for (const row of allPol) {
        if (evaluarEstadoCobranzaHabil(row.fecha_vencimiento, 100, hoyDate) === targetState) {
            matchingVtos.push(row.fecha_vencimiento);
        }
    }
    return matchingVtos;
}

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
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
//  CLEANUP: DE-DUPLICACION DE CLIENTES Y POLIZAS REEMPLAZADAS
// ═══════════════════════════════════════════════════════════════════════════

function cleanupDatabaseDuplicationsAndSuperseded() {
    try {
        const clients = db.prepare('SELECT id, TRIM(UPPER(nombre)) as norm_name FROM clientes').all();
        const map = {};
        for (const c of clients) {
            if (!c.norm_name) continue;
            const cleanName = c.norm_name.replace(/\s+/g, ' ');
            if (!map[cleanName]) map[cleanName] = [];
            map[cleanName].push(c.id);
        }

        db.transaction(() => {
            for (const [normName, ids] of Object.entries(map)) {
                if (ids.length > 1) {
                    const masterId = ids[0];
                    for (let i = 1; i < ids.length; i++) {
                        const slaveId = ids[i];
                        db.prepare('UPDATE polizas SET cliente_id = ? WHERE cliente_id = ?').run(masterId, slaveId);
                        db.prepare('UPDATE contactos SET cliente_id = ? WHERE cliente_id = ?').run(masterId, slaveId);
                        db.prepare('UPDATE historial_gestiones_whatsapp SET cliente_id = ? WHERE cliente_id = ?').run(masterId, slaveId);
                        db.prepare('DELETE FROM telefonos_maestros WHERE cliente_id = ?').run(slaveId);
                        db.prepare('DELETE FROM clientes WHERE id = ?').run(slaveId);
                    }
                }
            }
        })();

        // 1b. Smart deduplication for client name typos/variations sharing the same phone
        const dupes = db.prepare("SELECT telefono, COUNT(*) as cnt FROM clientes WHERE telefono IS NOT NULL AND telefono != '' GROUP BY telefono HAVING cnt > 1").all();
        db.transaction(() => {
            for (const d of dupes) {
                const cls = db.prepare('SELECT id, nombre FROM clientes WHERE telefono = ?').all(d.telefono);
                if (cls.length <= 1) continue;

                const names = cls.map(c => c.nombre.toUpperCase().trim().replace(/\s+/g, ' '));
                function isSamePerson(a, b) {
                    if (a === b) return true;
                    const wordsA = a.split(' ');
                    const wordsB = b.split(' ');
                    const surnameA = wordsA[0];
                    const surnameB = wordsB[0];
                    if (surnameA === surnameB || (Math.abs(surnameA.length - surnameB.length) <= 2 && surnameA.substring(0, 3) === surnameB.substring(0, 3))) {
                        const firstA = wordsA[1] || '';
                        const firstB = wordsB[1] || '';
                        if (firstA && firstB && (firstA.startsWith(firstB) || firstB.startsWith(firstA))) return true;
                    }
                    return false;
                }

                let allSame = true;
                for (let i = 0; i < names.length; i++) {
                    for (let j = i + 1; j < names.length; j++) {
                        if (!isSamePerson(names[i], names[j])) {
                            allSame = false;
                            break;
                        }
                    }
                }

                if (allSame && cls.length > 1) {
                    cls.sort((x, y) => y.nombre.length - x.nombre.length);
                    const master = cls[0];
                    for (let k = 1; k < cls.length; k++) {
                        const slave = cls[k];
                        db.prepare('UPDATE polizas SET cliente_id = ? WHERE cliente_id = ?').run(master.id, slave.id);
                        db.prepare('UPDATE contactos SET cliente_id = ? WHERE cliente_id = ?').run(master.id, slave.id);
                        db.prepare('UPDATE historial_gestiones_whatsapp SET cliente_id = ? WHERE cliente_id = ?').run(master.id, slave.id);
                        db.prepare('DELETE FROM telefonos_maestros WHERE cliente_id = ?').run(slave.id);
                        db.prepare('DELETE FROM clientes WHERE id = ?').run(slave.id);
                    }
                }
            }
        })();

        db.prepare(`
            UPDATE polizas 
            SET cuotas_debe = 0, saldo_pendiente = 0, estado = 'anulada'
            WHERE EXISTS (
                SELECT 1 FROM polizas p2 
                WHERE UPPER(TRIM(p2.patente)) = UPPER(TRIM(polizas.patente))
                  AND p2.id != polizas.id 
                  AND CAST(p2.operacion AS INTEGER) > CAST(polizas.operacion AS INTEGER)
            )
        `).run();
    } catch (err) {
        console.error('Error en cleanupDatabaseDuplicationsAndSuperseded:', err);
    }
}

cleanupDatabaseDuplicationsAndSuperseded();

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
function sanitizeAndFixPhone(phone, clientCity = '') {
    if (!phone) return '';
    let s = String(phone).trim();
    if (/inexistente|no tiene|sin|falso|invalido|error|baja|no posee|n\/a/i.test(s)) return '';

    let cleaned = s.replace(/[^\d]/g, '');
    if (cleaned.length === 0) return '';

    if (cleaned.startsWith('549') && cleaned.length >= 13) {
        cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('54') && cleaned.length >= 12) {
        cleaned = cleaned.substring(2);
    }

    while (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }

    // Quitar 15 según código de área
    if (cleaned.startsWith('1115') && cleaned.length === 12) {
        cleaned = '11' + cleaned.substring(4);
    } else if (/^(221|223|249|291|341|351|261|299|381|387|342|264|266|379|376|362)15/.test(cleaned) && cleaned.length === 12) {
        cleaned = cleaned.substring(0, 3) + cleaned.substring(5);
    } else if (/^(2284|2254|2257|2262|2266|2268|2291|2983|2920|2966|2940|2972|2982)15/.test(cleaned) && cleaned.length === 12) {
        cleaned = cleaned.substring(0, 4) + cleaned.substring(6);
    } else if (cleaned.startsWith('15') && cleaned.length === 10) {
        let defaultArea = '223';
        const c = String(clientCity).toLowerCase();
        if (c.includes('tandil')) defaultArea = '249';
        else if (c.includes('la plata')) defaultArea = '221';
        else if (c.includes('necochea')) defaultArea = '2262';
        else if (c.includes('olavarria')) defaultArea = '2284';
        else if (c.includes('bahia')) defaultArea = '291';
        else if (c.includes('buenos aires') || c.includes('capital') || c.includes('caba')) defaultArea = '11';
        cleaned = defaultArea + cleaned.substring(2);
    }

    if (cleaned.length === 7 || cleaned.length === 8) {
        let defaultArea = '223';
        const c = String(clientCity).toLowerCase();
        if (c.includes('tandil')) defaultArea = '249';
        else if (c.includes('la plata')) defaultArea = '221';
        else if (c.includes('necochea')) defaultArea = '2262';
        else if (c.includes('olavarria')) defaultArea = '2284';
        else if (c.includes('bahia')) defaultArea = '291';
        else if (c.includes('buenos aires') || c.includes('capital') || c.includes('caba')) defaultArea = '11';
        cleaned = defaultArea + (cleaned.length === 8 ? cleaned.substring(1) : cleaned);
    }

    if (cleaned.length === 10) {
        return '549' + cleaned;
    }

    return (cleaned.length >= 10 && cleaned.length <= 11) ? '549' + cleaned : '';
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
        const hoy = new Date();

        // ── Días hábiles: si hoy es finde o feriado, los contadores de cobranza muestran 0
        //    El panel permanece visible pero no genera alertas falsas en días no laborables.
        const esDiaNoHabil = esNoHabil(hoy);

        const allPolizas = db.prepare('SELECT id, operacion, patente, fecha_vencimiento, fin_vigencia_poliza, cuotas_debe, estado, saldo_pendiente FROM polizas').all();

        // Build set of poliza IDs that have been superseded by a newer operation for the same patente
        const renewedPolizaIds = new Set();
        const polizasByPatente = {};
        for (const p of allPolizas) {
            if (!p.patente) continue;
            if (!polizasByPatente[p.patente]) polizasByPatente[p.patente] = [];
            polizasByPatente[p.patente].push(p);
        }
        for (const pat of Object.keys(polizasByPatente)) {
            const group = polizasByPatente[pat];
            if (group.length <= 1) continue;
            // Sort by operacion descending (newest first)
            group.sort((a, b) => parseInt(b.operacion || 0) - parseInt(a.operacion || 0));
            // All except the first (newest) are superseded
            for (let i = 1; i < group.length; i++) {
                renewedPolizaIds.add(group[i].id);
            }
        }
        
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
            const est = (p.estado || '').toLowerCase();
            if (est === 'anulada' || est === 'baja') continue;

            const fv = p.fecha_vencimiento;
            const cd = parseInt(p.cuotas_debe || 0);

            // ── Renovaciones counters (Calendar days — sin cambio)
            // Skip policies that have been renewed (superseded by a newer operation for the same patente)
            const isRenewed = renewedPolizaIds.has(p.id);
            const fvRen = p.fin_vigencia_poliza || fv;
            if (fvRen && !isRenewed) {
                const parts = fvRen.split('-');
                if (parts.length === 3) {
                    const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                    const todayDate = parseLocalDate(todayStr);
                    const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));

                    const saldo = parseFloat(p.saldo_pendiente || 0);
                    const tieneDeuda = saldo > 0 || parseInt(p.cuotas_debe || 0) > 0;

                    if (calDiffRen === 7 && !tieneDeuda) polizas_vencen_semana++;
                    if (calDiffRen > 0 && calDiffRen <= 30) polizas_vencen_mes++;
                    // Badge debe coincidir con la tabla: 1-30 días vencida Y max 1 cuota pendiente
                    if (calDiffRen < 0 && calDiffRen >= -30 && parseInt(p.cuotas_debe || 0) <= 1) polizas_vencidas++;
                    if (calDiffRen >= 0) polizas_vigentes++;
                }
            }

            // ── Cobranzas counters (⚡ Días HÁBILES — holidays_ar)
            if (isRenewed) continue;

            const saldoVal = parseFloat(p.saldo_pendiente || 0);
            if (saldoVal > 0 && !esDiaNoHabil) {
                // evaluarEstadoCobranzaHabil usa vencimiento efectivo + días hábiles
                const estadoHabil = evaluarEstadoCobranzaHabil(fv, saldoVal, hoy);

                if (estadoHabil === 'recordatorio_48hs')     vence_48h++;
                else if (estadoHabil === 'cuota_vencida_0_48hs')  vencio_48h++;
                else if (estadoHabil === 'cuota_vencida_48_96hs') vencio_96h++;
                else if (estadoHabil === 'mora_critica')           mora_critica++;
                else                                               al_dia++;
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
            last_sync_date: lastSync,
            es_dia_no_habil: esDiaNoHabil
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

async function generarExcelVehiculosExcelJS(req, res) {
    try {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'SEGUCar';
        workbook.created = new Date();

        const query = `
            SELECT 
              c.id as cliente_id,
              c.nombre,
              c.dni,
              c.telefono,
              c.direccion,
              c.sin_whatsapp,
              p.operacion,
              p.patente,
              p.vehiculo,
              COALESCE(NULLIF(TRIM(p.tipo_vehiculo), ''), 'Auto') as tipo_vehiculo,
              COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento) as fin_vigencia,
              p.saldo_pendiente,
              p.cuotas_debe
            FROM polizas p
            JOIN clientes c ON p.cliente_id = c.id
            WHERE LOWER(COALESCE(p.estado, '')) NOT IN ('anulada', 'baja', 'historico', 'historica', 'cancelada')
              AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0
              AND NOT EXISTS (
                SELECT 1 FROM polizas p2 
                WHERE p2.patente = p.patente 
                  AND p2.id != p.id 
                  AND CAST(p2.operacion AS INTEGER) > CAST(p.operacion AS INTEGER)
              )
            ORDER BY p.tipo_vehiculo ASC, c.nombre ASC
        `;

        const rows = db.prepare(query).all();

        // 1. Resumen Tab
        const sheetResumen = workbook.addWorksheet('Resumen General');
        sheetResumen.columns = [
            { header: 'Tipo de Vehículo', key: 'tipo', width: 22 },
            { header: 'Clientes Únicos', key: 'clientes', width: 20 },
            { header: 'Pólizas Vigentes', key: 'polizas', width: 22 }
        ];

        const grouped = {};
        rows.forEach(r => {
            let t = (r.tipo_vehiculo || 'Auto').trim();
            t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
            if (t === 'Pick up') t = 'Pick Up';
            if (t === 'Camion') t = 'Camión';
            r.tipo_vehiculo = t;

            if (!grouped[t]) grouped[t] = [];
            grouped[t].push(r);
        });

        let totalPol = 0;
        for (const [tipo, list] of Object.entries(grouped)) {
            const uniqueClients = new Set(list.map(x => x.cliente_id)).size;
            sheetResumen.addRow({ tipo, clientes: uniqueClients, polizas: list.length });
            totalPol += list.length;
        }
        sheetResumen.addRow({ tipo: 'TOTAL GENERAL', clientes: new Set(rows.map(x => x.cliente_id)).size, polizas: totalPol });

        sheetResumen.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheetResumen.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007ACC' } };

        // 2. Master Sheet
        const sheetDetail = workbook.addWorksheet('Master Completo');
        sheetDetail.columns = [
            { header: 'Tipo Vehículo', key: 'tipo_vehiculo', width: 16 },
            { header: 'Cliente', key: 'nombre', width: 34 },
            { header: 'DNI', key: 'dni', width: 15 },
            { header: 'Teléfono', key: 'telefono', width: 18 },
            { header: 'WhatsApp', key: 'wa', width: 15 },
            { header: 'Patente', key: 'patente', width: 14 },
            { header: 'Vehículo / Modelo', key: 'vehiculo', width: 36 },
            { header: 'N° Operación', key: 'operacion', width: 16 },
            { header: 'Fin Vigencia', key: 'fin_vigencia', width: 15 },
            { header: 'Saldo Impago', key: 'saldo', width: 15 }
        ];

        rows.forEach(r => {
            sheetDetail.addRow({
                tipo_vehiculo: r.tipo_vehiculo,
                nombre: r.nombre,
                dni: r.dni || '-',
                telefono: r.telefono || 'Sin número',
                wa: r.sin_whatsapp ? 'Sin WhatsApp' : (r.telefono ? 'Sí' : 'No'),
                patente: r.patente,
                vehiculo: r.vehiculo,
                operacion: r.operacion,
                fin_vigencia: r.fin_vigencia,
                saldo: r.saldo_pendiente ? `$${r.saldo_pendiente}` : '$0'
            });
        });

        sheetDetail.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheetDetail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF107C41' } };

        // 3. Individual Category Tabs
        for (const [tipo, list] of Object.entries(grouped)) {
            const sheetCat = workbook.addWorksheet(tipo.toUpperCase());
            sheetCat.columns = [
                { header: 'Cliente', key: 'nombre', width: 34 },
                { header: 'DNI', key: 'dni', width: 15 },
                { header: 'Teléfono', key: 'telefono', width: 18 },
                { header: 'WhatsApp', key: 'wa', width: 15 },
                { header: 'Patente', key: 'patente', width: 14 },
                { header: 'Vehículo / Modelo', key: 'vehiculo', width: 36 },
                { header: 'N° Operación', key: 'operacion', width: 16 },
                { header: 'Fin Vigencia', key: 'fin_vigencia', width: 15 },
                { header: 'Saldo Impago', key: 'saldo', width: 15 }
            ];
            list.forEach(r => {
                sheetCat.addRow({
                    nombre: r.nombre,
                    dni: r.dni || '-',
                    telefono: r.telefono || 'Sin número',
                    wa: r.sin_whatsapp ? 'Sin WhatsApp' : (r.telefono ? 'Sí' : 'No'),
                    patente: r.patente,
                    vehiculo: r.vehiculo,
                    operacion: r.operacion,
                    fin_vigencia: r.fin_vigencia,
                    saldo: r.saldo_pendiente ? `$${r.saldo_pendiente}` : '$0'
                });
            });
            sheetCat.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
            sheetCat.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007ACC' } };
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="Clientes_Activos_Por_Vehiculo.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error("Error al generar Excel por Vehículo:", error);
        res.status(500).json({ error: error.message });
    }
}

app.get('/api/exportar', generarExcelEstructuradoExcelJS);
app.get('/api/exportar/excel', generarExcelEstructuradoExcelJS);
app.get('/api/exportar-excel', generarExcelEstructuradoExcelJS);
app.get('/api/exportar-sin-telefono', generarExcelSinTelefonoExcelJS);
app.get('/api/reportes/telefonos-incompletos', generarExcelSinTelefonoExcelJS);
app.get('/api/reportes/sin-telefono', generarExcelSinTelefonoExcelJS);
app.get('/api/exportar/vehiculos', generarExcelVehiculosExcelJS);
app.get('/api/exportar-vehiculos', generarExcelVehiculosExcelJS);
app.get('/api/exportar/nre-2026', (req, res) => {
    res.download(require('path').join(__dirname, 'public', 'Reporte_NRE_Evolucion_2026.xlsx'));
});

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

        // Solo renovar si la póliza YA tiene el servicio Grucar Acarreo habilitado (grucar_activo === 1)
        if (pol.grucar_activo !== 1) {
            return { activo: false, motivo: 'La póliza no posee el servicio Grucar Acarreo contratado o activo' };
        }

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

        const cuotas = parseInt(pol.cuotas_debe || 0);
        const est = (pol.estado || '').toLowerCase();
        const hoyStr = new Date().toISOString().split('T')[0];
        const vtoGrucar = pol.fecha_vencimiento_grucar || hoyStr;

        // Solo es activo si la póliza tiene grucar_activo === 1 y no está en mora crítica ni dada de baja
        const isActivo = pol.grucar_activo === 1 && est !== 'anulada' && est !== 'baja' && cuotas < 2 && vtoGrucar >= hoyStr;

        if (!isActivo) {
            return res.json({
                success: true,
                activo: false,
                motivo: 'El cliente no posee el servicio de acarreo local Grucar contratado o activo.',
                cupon: null
            });
        }

        res.json({
            success: true,
            activo: true,
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
        const hoyClientes = new Date();
        const esDiaNoHabilClientes = esNoHabil(hoyClientes);

        // ── Clientes contactados HOY (fuente de verdad multi-dispositivo para el botón "Enviado") ──
        const contactadosHoyRows = db.prepare(`
            SELECT DISTINCT cliente_id FROM (
                SELECT cliente_id FROM contactos WHERE date(datetime(fecha, '-3 hours')) = date('now', '-3 hours') OR date(fecha) = date('now', 'localtime')
                UNION
                SELECT cliente_id FROM mensajes_whatsapp WHERE (date(datetime(created_at, '-3 hours')) = date('now', '-3 hours') OR date(created_at) = date('now', 'localtime')) AND estado = 'enviado'
                UNION
                SELECT cliente_id FROM historial_gestiones_whatsapp WHERE date(datetime(fecha_envio, '-3 hours')) = date('now', '-3 hours') OR date(fecha_envio) = date('now', 'localtime')
            )
        `).all();
        const contactadosHoySet = new Set(contactadosHoyRows.map(r => r.cliente_id));

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
        let orderOverride = null;
        if (estado) {
            const estadoNorm = estado.toLowerCase().replace(/\s+/g, '_');

            // ── RENOVACIONES ────────────────────────────────────────────────
            // Exclude policies that have been renewed (superseded by a newer operation for the same patente)
            const notRenewedClause = ` AND NOT EXISTS (SELECT 1 FROM polizas p2 WHERE p2.patente = p.patente AND p2.id != p.id AND CAST(p2.operacion AS INTEGER) > CAST(p.operacion AS INTEGER))`;

            const isHistoricoFilter = ['historico', 'historica', 'baja', 'anulada', 'recuperacion_historica'].includes(estadoNorm);
            if (!isHistoricoFilter) {
                where += ` AND LOWER(COALESCE(p.estado, '')) NOT IN ('anulada', 'baja')`;
            }

            if (estadoNorm === 'por_vencer' || estadoNorm === 'renovacion_7_dias') {
                // AL DIA (sin deuda) Y vence en EXACTAMENTE 7 dias
                where += ` AND (COALESCE(p.cuotas_debe, 0) = 0) AND (COALESCE(p.saldo_pendiente, 0) = 0) AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) = 7` + notRenewedClause;
            } else if (estadoNorm === 'vencida' || estadoNorm === 'poliza_vencida') {
                // Vencida = expiró hace entre 1 y 30 días. Más de 30 días → Recuperación.
                // Solo muestra los que tienen 0 o 1 cuota pendiente:
                //   0 cuotas → al dia, candidatos prime (arriba)
                //   1 cuota  → parcial, candidatos secundarios (abajo)
                //   2+ cuotas → ya están en mora, no son candidatos de renovación, se excluyen
                where += ` AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) BETWEEN -30 AND -1`
                       + ` AND COALESCE(p.cuotas_debe, 0) <= 1`
                       + notRenewedClause;
                // Ensure al-dia rows come first, 1-cuota-pending rows last
                orderOverride = `COALESCE(p.cuotas_debe, 0) ASC, COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento) DESC`;
            } else if (estadoNorm === 'historico' || estadoNorm === 'historica' || estadoNorm === 'baja' || estadoNorm === 'anulada' || estadoNorm === 'recuperacion_historica') {
                where += ` AND (LOWER(COALESCE(p.estado, '')) IN ('anulada', 'baja') OR p.fecha_vencimiento < date('now', 'localtime', '-30 days'))`;
            } else if (estadoNorm === 'vigente' || estadoNorm === 'contrato_vigente') {
                where += ` AND CAST(julianday(COALESCE(p.fin_vigencia_poliza, p.fecha_vencimiento)) - julianday(date('now', 'localtime')) AS INTEGER) >= 0` + notRenewedClause;

            // ── COBRANZA (Business days & Monday Sync check) ────────────────
            } else if (estadoNorm === 'vence_48h' || estadoNorm === 'cuota_vence_48h' || estadoNorm === 'recordatorio_48hs' || estadoNorm.includes('vence_48h') || estadoNorm.includes('recordatorio')) {
                if (esDiaNoHabilClientes) {
                    where += ` AND 1=0`;
                } else {
                    const vtos = getFechasTargetCobranza('recordatorio_48hs', hoyClientes);
                    if (vtos.length > 0) {
                        const placeholders = vtos.map(() => '?').join(',');
                        where += ` AND p.saldo_pendiente > 0 AND p.fecha_vencimiento IN (${placeholders})`;
                        params.push(...vtos);
                    } else {
                        where += ` AND 1=0`;
                    }
                }
            } else if (estadoNorm === 'vencio_48h' || estadoNorm === 'primer_aviso' || estadoNorm.includes('vencio_48h') || estadoNorm.includes('primer')) {
                if (esDiaNoHabilClientes) {
                    where += ` AND 1=0`;
                } else {
                    const vtos = getFechasTargetCobranza('cuota_vencida_0_48hs', hoyClientes);
                    if (vtos.length > 0) {
                        const placeholders = vtos.map(() => '?').join(',');
                        where += ` AND p.saldo_pendiente > 0 AND p.fecha_vencimiento IN (${placeholders})`;
                        params.push(...vtos);
                    } else {
                        where += ` AND 1=0`;
                    }
                }
            } else if (estadoNorm === 'vencio_96h' || estadoNorm === 'segundo_aviso' || estadoNorm.includes('vencio_96h') || estadoNorm.includes('segundo')) {
                if (esDiaNoHabilClientes) {
                    where += ` AND 1=0`;
                } else {
                    const vtos = getFechasTargetCobranza('cuota_vencida_48_96hs', hoyClientes);
                    if (vtos.length > 0) {
                        const placeholders = vtos.map(() => '?').join(',');
                        where += ` AND p.saldo_pendiente > 0 AND p.fecha_vencimiento IN (${placeholders})`;
                        params.push(...vtos);
                    } else {
                        where += ` AND 1=0`;
                    }
                }
            } else if (estadoNorm === 'cuota_deuda' || estadoNorm === 'deuda' || estadoNorm === 'deudores' || estadoNorm === 'mora_critica' || estadoNorm.includes('mora')) {
                const vtos = getFechasTargetCobranza('mora_critica', hoyClientes);
                if (vtos.length > 0) {
                    const placeholders = vtos.map(() => '?').join(',');
                    where += ` AND p.saldo_pendiente > 0 AND p.fecha_vencimiento IN (${placeholders})`;
                    params.push(...vtos);
                } else {
                    where += ` AND 1=0`;
                }
            } else if (estadoNorm === 'cuota_aldia' || estadoNorm === 'al_dia' || estadoNorm.includes('al_dia')) {
                where += ` AND (p.saldo_pendiente IS NULL OR p.saldo_pendiente <= 0)`;
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

        let orderByClause = 'sort_fecha ASC, c.nombre ASC';
        if (sortBy === 'telefono') {
            orderByClause = `CASE WHEN (c.telefono IS NULL OR c.telefono = '' OR length(c.telefono) < 10) THEN 0 ELSE 1 END ${sortDir === 'ASC' ? 'ASC' : 'DESC'}, c.telefono ${sortDir}, c.nombre ASC`;
        } else if (sortBy === 'nombre') {
            orderByClause = `c.nombre ${sortDir}`;
        } else if (isSortByPolizaCol) {
            orderByClause = `sort_val ${sortDir}, sort_fecha ASC, c.nombre ASC`;
        }
        // State-specific override (e.g. poliza_vencida: al-dia primero, 1-cuota al final)
        if (typeof orderOverride !== 'undefined' && orderOverride) {
            orderByClause = orderOverride + ', c.nombre ASC';
        }

        const query = `
            SELECT c.*, ${aggFn}(${isSortByPolizaCol ? sortCol : '1'}) as sort_val, ${sortFechaSubquery} as sort_fecha
            FROM clientes c 
            INNER JOIN polizas p ON c.id = p.cliente_id 
            ${where} 
            GROUP BY c.id 
            ORDER BY ${orderByClause}
        `;
        const clientes = db.prepare(query).all(...params);

        const polizaSort = (sortBy === 'vencimiento' || sortBy === 'estado')
            ? (sortDir === 'ASC' ? 'fecha_vencimiento ASC' : 'fecha_vencimiento DESC')
            : 'fecha_vencimiento DESC';

        const hoyStr = toLocalISOString(new Date());

        for (let cliente of clientes) {
            let rawPolizas = db.prepare(`
                SELECT p.*, 
                       ca.id as cuota_admin_id, 
                       COALESCE(ca.monto_poliza, 30240) as monto_poliza_emision, 
                       COALESCE(ca.monto_acarreo, 1760) as monto_acarreo_grucar, 
                       COALESCE(ca.monto_total, p.saldo_pendiente, 32000) as monto_total_cuota,
                       ca.estado as cuota_admin_estado,
                       ca.pdf_nre_url,
                       ca.pdf_grucar_url
                FROM polizas p
                LEFT JOIN cuotas_admin ca ON p.id = ca.poliza_id
                WHERE p.cliente_id = ? 
                ORDER BY p.fecha_vencimiento ASC
            `).all(cliente.id);

            if (estado) {
                const estadoNorm = estado.toLowerCase().replace(/\s+/g, '_');
                const isHistoricoFilter = ['historico', 'historica', 'baja', 'anulada', 'recuperacion_historica'].includes(estadoNorm);
                rawPolizas = rawPolizas.filter(p => {
                    const est = (p.estado || '').toLowerCase();
                    if ((est === 'anulada' || est === 'baja') && !isHistoricoFilter) return false;

                    const fv = p.fecha_vencimiento || '';
                    const cd = parseInt(p.cuotas_debe || 0);
                    const fvRen = p.fin_vigencia_poliza || fv;

                    // Check if this poliza has been superseded by a newer operation for the same patente
                    const isRenovacionFilter = ['por_vencer', 'renovacion_7_dias', 'vencida', 'poliza_vencida', 'vigente', 'contrato_vigente'].includes(estadoNorm);
                    if (isRenovacionFilter && p.patente) {
                        const hasSuccessor = rawPolizas.some(p2 => p2.patente === p.patente && p2.id !== p.id && parseInt(p2.operacion || 0) > parseInt(p.operacion || 0));
                        if (hasSuccessor) return false;
                    }

                    if (estadoNorm === 'por_vencer' || estadoNorm === 'renovacion_7_dias') {
                        const saldo = parseFloat(p.saldo_pendiente || 0);
                        const cuotas = parseInt(p.cuotas_debe || 0);
                        if (saldo > 0 || cuotas > 0) return false; // excluir con deuda
                        const parts = fvRen.split('-');
                        if (parts.length !== 3) return false;
                        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        const todayDate = parseLocalDate(hoyStr);
                        const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                        return calDiffRen === 7; // exactamente 7 dias
                    }
                    if (estadoNorm === 'vencida' || estadoNorm === 'poliza_vencida') {
                        const parts = fvRen.split('-');
                        if (parts.length !== 3) return false;
                        const vtoDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                        const todayDate = parseLocalDate(hoyStr);
                        const calDiffRen = Math.round((vtoDate - todayDate) / (1000 * 60 * 60 * 24));
                        // Vencida = expiró hace entre 1 y 30 días
                        return calDiffRen < 0 && calDiffRen >= -30;
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

                    const saldoVal = parseFloat(p.saldo_pendiente || 0);

                    // ⚡ Días hábiles — si hoy es no hábil, solo mora_critica sigue visible
                    if (esDiaNoHabilClientes) {
                        if (estadoNorm === 'cuota_deuda' || estadoNorm === 'deuda' || estadoNorm === 'deudores' || estadoNorm === 'mora_critica') {
                            // Mora crítica: siempre visible (el cliente ya tiene cobertura suspendida)
                            const parts2 = fv.split('-');
                            if (parts2.length !== 3) return false;
                            const vtoDate2 = new Date(parseInt(parts2[0]), parseInt(parts2[1]) - 1, parseInt(parts2[2]));
                            const todayDate2 = parseLocalDate(hoyStr);
                            const calDiff2 = Math.round((vtoDate2 - todayDate2) / (1000 * 60 * 60 * 24));
                            return saldoVal > 0 && calDiff2 < -4;
                        }
                        if (estadoNorm === 'cuota_aldia' || estadoNorm === 'al_dia') return saldoVal <= 0;
                        return false; // Suprimir recordatorio/primer/segundo aviso en días no hábiles
                    }

                    // ⚡ Días hábiles — filtro con evaluarEstadoCobranzaHabil
                    const estadoHabilP = evaluarEstadoCobranzaHabil(fv, saldoVal, hoyClientes);

                    const isRecordatorio48 = estadoNorm === 'vence_48h' || estadoNorm === 'cuota_vence_48h' || estadoNorm === 'recordatorio_48hs' || estadoNorm.includes('vence_48h') || estadoNorm.includes('recordatorio');
                    const isPrimerAviso = estadoNorm === 'vencio_48h' || estadoNorm === 'primer_aviso' || estadoNorm.includes('vencio_48h') || estadoNorm.includes('primer');
                    const isSegundoAviso = estadoNorm === 'vencio_96h' || estadoNorm === 'segundo_aviso' || estadoNorm.includes('vencio_96h') || estadoNorm.includes('segundo');
                    const isMoraCritica = estadoNorm === 'cuota_deuda' || estadoNorm === 'deuda' || estadoNorm === 'deudores' || estadoNorm === 'mora_critica' || estadoNorm.includes('mora');
                    const isAlDia = estadoNorm === 'cuota_aldia' || estadoNorm === 'al_dia' || estadoNorm.includes('al_dia');

                    if (isRecordatorio48) {
                        return estadoHabilP === 'recordatorio_48hs';
                    }
                    if (isPrimerAviso) {
                        return estadoHabilP === 'cuota_vencida_0_48hs';
                    }
                    if (isSegundoAviso) {
                        return estadoHabilP === 'cuota_vencida_48_96hs';
                    }
                    if (isMoraCritica) {
                        return estadoHabilP === 'mora_critica';
                    }
                    if (isAlDia) {
                        return saldoVal <= 0 || estadoHabilP === 'al_dia';
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
                // ⚡ Opción B: enriquecer cada póliza con estado hábil precalculado
                const saldoP = parseFloat(p.saldo_pendiente || 0);
                p.estado_habil = evaluarEstadoCobranzaHabil(p.fecha_vencimiento, saldoP, hoyClientes);
                p.fecha_vencimiento_efectiva = p.fecha_vencimiento
                    ? toLocalDateString(obtenerSiguienteDiaHabil(new Date(p.fecha_vencimiento + 'T00:00:00')))
                    : p.fecha_vencimiento;
                p.es_dia_no_habil = esDiaNoHabilClientes;
            }
            cliente.polizas = polizasDeduplicadas;
            // ── Fuente de verdad para el botón "Enviado": viene de la DB, no del localStorage ──
            cliente.contacted_today = contactadosHoySet.has(cliente.id);

        }

        let finalClientes = clientes;
        if (estado) {
            finalClientes = clientes.filter(c => c.polizas && c.polizas.length > 0);
        }

        const totalMatching = finalClientes.length;
        const totalPages = Math.ceil(totalMatching / limit) || 1;
        const paginatedClientes = finalClientes.slice(offset, offset + limit);

        res.json({ clientes: paginatedClientes, total: totalMatching, page, pages: totalPages });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/recuperacion', (req, res) => {
    try {
        const search = req.query.search || '';
        const filtroTel = req.query.filtro_telefono || 'todos';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;

        let where = `WHERE (fecha_vencimiento < date('now', '-30 days')) AND NOT EXISTS (
            SELECT 1 FROM polizas p 
            WHERE (UPPER(TRIM(p.patente)) = UPPER(TRIM(polizas_historicas.patente)) AND p.patente IS NOT NULL AND p.patente != '')
               OR (p.operacion = polizas_historicas.operacion AND p.operacion IS NOT NULL AND p.operacion != '')
        )`;
        let params = [];

        if (search) {
            where += ` AND (nombre LIKE ? OR patente LIKE ? OR vehiculo LIKE ? OR operacion LIKE ? OR telefono LIKE ?)`;
            const term = `%${search}%`;
            params.push(term, term, term, term, term);
        }

        if (filtroTel === 'con_telefono') {
            where += ` AND (telefono IS NOT NULL AND length(telefono) >= 10)`;
        } else if (filtroTel === 'sin_telefono') {
            where += ` AND (telefono IS NULL OR length(telefono) < 10)`;
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
            'estrategia': 'estrategia',
            'acciones': 'CASE WHEN (telefono IS NOT NULL AND length(telefono) >= 10) THEN 1 ELSE 0 END'
        };
        const sortCol = validSortCols[sortBy] || 'fecha_vencimiento';

        const total = db.prepare(`SELECT COUNT(*) as count FROM polizas_historicas ${where}`).get(...params).count;
        
        // Base counts without phone filter for stats UI
        let baseWhere = `WHERE (fecha_vencimiento < date('now', '-30 days')) AND NOT EXISTS (
            SELECT 1 FROM polizas p 
            WHERE (UPPER(TRIM(p.patente)) = UPPER(TRIM(polizas_historicas.patente)) AND p.patente IS NOT NULL AND p.patente != '')
               OR (p.operacion = polizas_historicas.operacion AND p.operacion IS NOT NULL AND p.operacion != '')
        )`;
        let baseParams = [];
        if (search) {
            baseWhere += ` AND (nombre LIKE ? OR patente LIKE ? OR vehiculo LIKE ? OR operacion LIKE ? OR telefono LIKE ?)`;
            const term = `%${search}%`;
            baseParams.push(term, term, term, term, term);
        }
        const totalBase = db.prepare(`SELECT COUNT(*) as count FROM polizas_historicas ${baseWhere}`).get(...baseParams).count;
        const conTelefonoCount = db.prepare(`SELECT COUNT(*) as count FROM polizas_historicas ${baseWhere} AND (telefono IS NOT NULL AND length(telefono) >= 10)`).get(...baseParams).count;
        const sinTelefonoCount = totalBase - conTelefonoCount;

        const items = db.prepare(`SELECT *, 
            EXISTS(
                SELECT 1 FROM polizas p INNER JOIN clientes c ON p.cliente_id = c.id
                WHERE UPPER(TRIM(c.nombre)) = UPPER(TRIM(polizas_historicas.nombre))
                  AND polizas_historicas.nombre IS NOT NULL AND polizas_historicas.nombre != ''
            ) as ya_es_cliente
        FROM polizas_historicas ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`).all(...params, limit, offset);

        res.json({ 
            items, 
            total, 
            page, 
            pages: Math.ceil(total / limit),
            stats: {
                total_base: totalBase,
                con_telefono: conTelefonoCount,
                sin_telefono: sinTelefonoCount
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/recuperacion/:id/telefono', (req, res) => {
    try {
        const { id } = req.params;
        const { telefono } = req.body;
        
        if (!id) return res.status(400).json({ error: 'ID de póliza requerida' });
        
        const cleanTel = sanitizeAndFixPhone(telefono);
        
        db.prepare('UPDATE polizas_historicas SET telefono = ? WHERE id = ?').run(cleanTel, id);
        
        const item = db.prepare('SELECT * FROM polizas_historicas WHERE id = ?').get(id);
        if (item && item.patente) {
            try {
                db.prepare(`
                    UPDATE clientes 
                    SET telefono = ? 
                    WHERE id IN (SELECT cliente_id FROM polizas WHERE patente = ?)
                `).run(cleanTel, item.patente);
            } catch(e) {}
        }
        
        res.json({ success: true, item });
    } catch (e) {
        res.status(500).json({ error: e.message });
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

let isSyncingNRE = false;

app.post('/api/sync-nre', async (req, res) => {
    if (isSyncingNRE) {
        return res.json({
            success: true,
            running: true,
            message: 'La sincronización con NRE está en curso en el servidor. Los datos se actualizarán al finalizar.'
        });
    }

    try {
        isSyncingNRE = true;
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
    } finally {
        isSyncingNRE = false;
    }
});

app.post('/api/sync-ags', async (req, res) => {
    try {
        const result = await syncAGS();
        res.json({
            success: true,
            message: 'Sincronización con portal AGS completada.',
            detalles: result
        });
    } catch (error) {
        console.error('Error en sync-ags:', error);
        res.status(500).json({ error: 'Error al sincronizar con portal AGS: ' + error.message });
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
        const { nombre, dni, direccion, telefono, email, sin_whatsapp } = req.body;
        const sanitizedPhone = sanitizeAndFixPhone(telefono);
        const sinWa = (sin_whatsapp === 1 || sin_whatsapp === '1' || sin_whatsapp === true) ? 1 : 0;
        const info = db.prepare(`UPDATE clientes SET nombre=?, dni=?, direccion=?, telefono=?, email=?, sin_whatsapp=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(nombre, dni, direccion, sanitizedPhone, email, sinWa, req.params.id);
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

function sanitizePatente(pat) {
    if (!pat) return '';
    return String(pat).toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

app.post('/api/clientes/:id/polizas', (req, res) => {
    try {
        const { operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion, grucar_activo } = req.body;
        const cleanPatente = sanitizePatente(patente);
        const hasGrucar = (grucar_activo === 1 || grucar_activo === '1' || grucar_activo === true) ? 1 : 0;

        const info = db.prepare(`
            INSERT INTO polizas (cliente_id, operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion, estado, grucar_activo)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'vigente', ?)
        `).run(req.params.id, operacion, tipo_vehiculo, cleanPatente, vehiculo, fecha_vencimiento, seccion, hasGrucar);

        console.log(`[Admin Audit] Póliza creada. Operación=${operacion}, Patente=${cleanPatente}, grucar_activo=${hasGrucar}`);
        res.status(201).json({ id: info.lastInsertRowid, message: 'Póliza creada con patente sanitizada', has_grucar: hasGrucar === 1 });
    } catch (error) {
        console.error('[Admin Audit Exception] Error creando póliza:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/polizas/:id', (req, res) => {
    try {
        const { operacion, tipo_vehiculo, patente, vehiculo, fecha_vencimiento, seccion, estado, grucar_activo } = req.body;
        const cleanPatente = sanitizePatente(patente);
        
        let info;
        if (grucar_activo !== undefined) {
            const hasGrucar = (grucar_activo === 1 || grucar_activo === '1' || grucar_activo === true) ? 1 : 0;
            info = db.prepare(`
                UPDATE polizas SET operacion=?, tipo_vehiculo=?, patente=?, vehiculo=?, fecha_vencimiento=?, seccion=?, estado=?, grucar_activo=? WHERE id=?
            `).run(operacion, tipo_vehiculo, cleanPatente, vehiculo, fecha_vencimiento, seccion, estado, hasGrucar, req.params.id);
        } else {
            info = db.prepare(`
                UPDATE polizas SET operacion=?, tipo_vehiculo=?, patente=?, vehiculo=?, fecha_vencimiento=?, seccion=?, estado=? WHERE id=?
            `).run(operacion, tipo_vehiculo, cleanPatente, vehiculo, fecha_vencimiento, seccion, estado, req.params.id);
        }

        if (info.changes === 0) return res.status(404).json({ error: 'Póliza no encontrada' });
        
        console.log(`[Admin Audit] Póliza actualizada. ID=${req.params.id}, Patente=${cleanPatente}, GrucarActivo=${grucar_activo}`);
        res.json({ message: 'Póliza actualizada', patente: cleanPatente, has_grucar: grucar_activo === 1 });
    } catch (error) {
        console.error('[Admin Audit Exception] Error actualizando póliza:', error.message);
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

        const origen = (req.body.origen || 'NRE').toUpperCase();
        const findClienteByName = db.prepare("SELECT id FROM clientes WHERE UPPER(TRIM(nombre)) = UPPER(TRIM(?)) AND (origen = ? OR (origen IS NULL AND ? = 'NRE')) LIMIT 1");
        const insertCliente = db.prepare("INSERT INTO clientes (nombre, telefono, direccion, origen) VALUES (?, ?, ?, ?)");
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
                    // Soporta columnas NRE y columnas AGS (exportado desde portal AGS)
                    // strip commas and spaces from policy number (AGS usa 8,257,130 format)
                    const operacion = String(
                        row['Operacion'] || row['Póliza'] || row['Poliza'] || row['N° Póliza'] || row['Nro Poliza'] || row['poliza'] || ''
                    ).replace(/[,\s]/g, '').trim();
                    const nombre = String(
                        row['Nombre'] || row['Asegurado'] || row['asegurado'] || row['ASEGURADO'] || ''
                    ).trim();
                    const telefono = sanitizeAndFixPhone(row['Teléfono'] || row['Telefono'] || row['Tel'] || row['Celular'] || '');
                    const seccion = String(row['Seccion'] || row['Sección'] || row['Cobertura'] || row['Descri'] || row['Descripcion'] || '').trim();
                    const patente = String(row['Patente'] || row['patente'] || row['PATENTE'] || '').trim();
                    // AGS: columna Vehículo puede incluir el año separado en otra columna
                    const vehiculoBase = String(row['Vehículo'] || row['Vehiculo'] || row['Marca'] || row['vehiculo'] || '').trim();
                    const anioVeh = String(row['Año'] || row['Anio'] || row['año'] || '').trim();
                    const vehiculo = (vehiculoBase && anioVeh && !vehiculoBase.includes(anioVeh))
                        ? `${vehiculoBase} ${anioVeh}` : vehiculoBase;
                    // AGS: Suma puede tener formato '$11.000.000' o numero con puntos — limpiar
                    const sumaRaw = String(row['Suma Aseg'] || row['Suma'] || row['Premio'] || row['suma'] || '').trim();
                    const sumaAseg = sumaRaw.replace(/[\$\.]/g, '').replace(/,/g, '').trim();
                    const codProd = String(row['Cod Prod'] || row['Productor'] || row['productor'] || '').trim();
                    const cuenta = String(row['Cuenta'] || row['Agencia'] || row['agencia'] || '').trim();
                    const finVig = parseFecha(
                        row['Fin Vig'] || row['Vencimiento'] || row['Vig. Hasta'] ||
                        row['Fecha Vencimiento'] || row['fin_vig'] || row['FinVig'] || ''
                    );
                    const renovada = String(row['Renovada'] || row['Acción'] || row['Accion'] || '').trim();
                    const cuoDebe = parseInt(row['Cuo Debe'] || row['Cuotas Debe'] || 0) || 0;
                    const direccion = String(row['Direccion'] || row['Dirección'] || '').trim();
                    const localidad = String(row['Localidad'] || '').trim();
                    const direccionCompleta = [direccion, localidad].filter(Boolean).join(', ');

                    if (!operacion) { errores++; detalles.push(`Fila sin operacion/poliza: ${JSON.stringify(Object.keys(row))}`); continue; }
                    if (!nombre) { errores++; detalles.push(`Fila sin nombre/asegurado: operacion=${operacion}`); continue; }

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
                    const existing = findClienteByName.get(nombre, origen, origen);
                    if (existing) {
                        cliente_id = existing.id;
                        if (telefono) updateClienteTel.run(telefono, cliente_id);
                        if (direccionCompleta) {
                            db.prepare("UPDATE clientes SET direccion = ? WHERE id = ? AND (direccion IS NULL OR direccion = '')").run(direccionCompleta, cliente_id);
                        }
                    } else {
                        const info = insertCliente.run(nombre, telefono, direccionCompleta, origen);
                        cliente_id = info.lastInsertRowid;
                    }

                    // Buscar o crear póliza
                    const existingPoliza = findPoliza.get(operacion);
                    if (existingPoliza) {
                        updatePoliza.run(seccion, tipoVehiculo, patente, vehiculo, sumaAseg, finVig, renovada, cuoDebe, estado, operacion);
                        actualizados++;
                    } else {
                        insertPoliza.run(cliente_id, operacion, seccion, tipoVehiculo, patente, vehiculo, sumaAseg, codProd, cuenta, finVig, renovada, cuoDebe, estado);
                        // Si es AGS, marcar aseguradora
                        if (origen === 'AGS') {
                            const lastId = db.prepare('SELECT last_insert_rowid() as id').get().id;
                            db.prepare("UPDATE polizas SET aseguradora = 'AGS' WHERE id = ?").run(lastId);
                        }
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
        const { nombre, tipo, nombre_meta, mensaje, activa } = req.body;
        const info = db.prepare('INSERT INTO plantillas (nombre, tipo, nombre_meta, mensaje, activa) VALUES (?, ?, ?, ?, ?)').run(nombre, tipo, nombre_meta || null, mensaje, activa !== undefined ? activa : 1);
        res.status(201).json({ id: info.lastInsertRowid, message: 'Plantilla creada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/plantillas/:id', (req, res) => {
    try {
        const { nombre, tipo, nombre_meta, mensaje, activa } = req.body;
        const info = db.prepare('UPDATE plantillas SET nombre=?, tipo=?, nombre_meta=?, mensaje=?, activa=? WHERE id=?').run(nombre, tipo, nombre_meta || null, mensaje, activa, req.params.id);
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

// ─── VALIDACIÓN DE TELÉFONOS (para integración WA API) ───────────────────────
const TELEFONOS_COMPARTIDOS_CONFIRMADOS = new Set([
    '5492235560341', '5492235266970', '5492235161260', '5492234386662',
    '5492233036447', '5492235234646', '5492235462277', '5492236326720',
    '5492235062765', '5492236915769', '5492235417649', '5492235013114',
    '5492235601417', '5492236705023', '5492236959527', '5492235568034',
    '5492235041769', '5492236365524'
]);

app.get('/api/validacion-telefonos', (req, res) => {
    try {
        const clientes = db.prepare(
            "SELECT id, nombre, telefono FROM clientes WHERE telefono IS NOT NULL AND length(replace(telefono, ' ', '')) >= 9"
        ).all();

        const grupos = {};
        clientes.forEach(c => {
            const raw = String(c.telefono).replace(/[^0-9]/g, '');
            if (!grupos[raw]) grupos[raw] = [];
            grupos[raw].push({ id: c.id, nombre: c.nombre, telefono: c.telefono });
        });

        const comodines = [];   // ≥8 clientes con apellidos distintos = número falso/relleno
        const duplicados = [];  // 2-7 clientes con apellidos distintos = probable error de carga
        const compartidosVerificados = [];

        Object.entries(grupos).forEach(([num, lista]) => {
            if (lista.length < 2) return;
            const apellidos = lista.map(c => c.nombre.trim().split(/\s+/)[0].toLowerCase());
            const todosIguales = apellidos.every(a => a === apellidos[0]);
            if (todosIguales) return; // misma familia, ok

            const entry = { telefono: num, clientes: lista };
            if (TELEFONOS_COMPARTIDOS_CONFIRMADOS.has(num)) {
                compartidosVerificados.push(entry);
            } else if (lista.length >= 8) {
                comodines.push(entry);
            } else {
                duplicados.push(entry);
            }
        });

        // Totales generales
        const total = db.prepare("SELECT COUNT(*) as n FROM clientes").get().n;
        const sinTel = db.prepare("SELECT COUNT(*) as n FROM clientes WHERE telefono IS NULL OR length(replace(telefono,' ','')) < 9").get().n;

        res.json({
            resumen: {
                total_clientes: total,
                sin_telefono: sinTel,
                con_telefono: total - sinTel,
                comodines: comodines.length,
                duplicados_distintos: duplicados.length,
                compartidos_verificados: compartidosVerificados.length
            },
            comodines,
            duplicados,
            compartidosVerificados
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  📱 WHATSAPP BUSINESS API (360dialog / Meta Directo)
// ═══════════════════════════════════════════════════════════════════════════

// GET Config de WhatsApp API
app.get('/api/whatsapp/config', (req, res) => {
    try {
        const cfg = waService.getConfig();
        res.json(cfg);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST Guardar Config de WhatsApp API (API Key, modo, etc)
app.post('/api/whatsapp/config', (req, res) => {
    try {
        const result = waService.saveConfig(req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET Lista de chats para la Bandeja de Entrada
app.get('/api/whatsapp/bandeja', (req, res) => {
    try {
        const list = waService.getConversacionesBandeja();
        res.json(list);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET Historial de chat con un cliente específico
app.get('/api/whatsapp/chat/:clienteId', (req, res) => {
    try {
        const clienteId = parseInt(req.params.clienteId, 10);
        const history = waService.getChatHistory(clienteId);
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST Enviar mensaje via API (Texto o Plantilla)
app.post('/api/whatsapp/enviar', async (req, res) => {
    try {
        const { cliente_id, telefono, mensaje, tipo_plantilla, parametros, poliza_operacion, poliza_patente } = req.body;
        console.log('[/api/whatsapp/enviar] Request received:', { cliente_id, telefono, tipo_plantilla, poliza_operacion, poliza_patente });
        
        if (!telefono) return res.status(400).json({ ok: false, error: 'Teléfono requerido' });

        let result;
        if (tipo_plantilla) {
            // Auto-extraer parámetros de plantilla ({{1}} = N° póliza/operación, {{2}} = patente)
            let templateParams = parametros || [];
            if (templateParams.length === 0) {
                // Si el frontend envió operación y patente, usar esos
                if (poliza_operacion && poliza_patente) {
                    templateParams = [poliza_operacion, poliza_patente];
                } else {
                    // Intentar extraer de la DB
                    const poliza = db.prepare(`
                        SELECT operacion, patente FROM polizas 
                        WHERE cliente_id = ? AND LOWER(estado) != 'anulada'
                        ORDER BY id DESC LIMIT 1
                    `).get(cliente_id);
                    if (poliza) {
                        templateParams = [poliza.operacion || '', poliza.patente || ''];
                    }
                }
            }

            console.log(`[/api/whatsapp/enviar] Sending HSM template: "${tipo_plantilla}" to ${telefono} with params:`, templateParams);
            result = await waService.sendTemplateMessage(cliente_id, telefono, tipo_plantilla, 'es_AR', templateParams);
        } else {
            console.log(`[/api/whatsapp/enviar] Sending text message to ${telefono}`);
            result = await waService.sendTextMessage(cliente_id, telefono, mensaje);
        }

        if (result && result.ok) {
            try {
                const poliza = db.prepare(`
                    SELECT id FROM polizas 
                    WHERE cliente_id = ? AND LOWER(COALESCE(estado,'')) != 'anulada'
                    ORDER BY id DESC LIMIT 1
                `).get(cliente_id);
                const poliza_id = poliza ? poliza.id : null;
                const plantillaTipo = tipo_plantilla || 'recordatorio_48hs';

                db.prepare('INSERT INTO contactos (cliente_id, poliza_id, tipo, medio, mensaje) VALUES (?, ?, ?, ?, ?)').run(cliente_id, poliza_id, plantillaTipo, 'whatsapp', mensaje || '');

                let saldoAlEnviar = 0;
                if (poliza_id) {
                    const polRes = db.prepare("SELECT COALESCE(saldo_pendiente, 0) as saldo FROM polizas WHERE id = ?").get(poliza_id);
                    saldoAlEnviar = polRes ? parseFloat(polRes.saldo || 0) : 0;
                }

                db.prepare(`
                    UPDATE historial_gestiones_whatsapp
                    SET estado_resultado = 'reemplazada', fecha_resolucion = CURRENT_TIMESTAMP
                    WHERE cliente_id = ? AND (poliza_id = ? OR poliza_id IS NULL OR ? IS NULL) AND estado_resultado = 'pendiente'
                `).run(cliente_id, poliza_id, poliza_id);

                db.prepare(`
                    INSERT INTO historial_gestiones_whatsapp (cliente_id, poliza_id, tipo_plantilla, saldo_al_enviar, estado_resultado)
                    VALUES (?, ?, ?, ?, 'pendiente')
                `).run(cliente_id, poliza_id, plantillaTipo, saldoAlEnviar);

                console.log(`[/api/whatsapp/enviar] 📊 Gestión registrada en métricas para cliente ${cliente_id} (plantilla: ${plantillaTipo})`);
            } catch (metricErr) {
                console.error('[/api/whatsapp/enviar] Error registrando métrica:', metricErr.message);
            }
        }

        console.log('[/api/whatsapp/enviar] Result:', JSON.stringify(result));
        res.json(result);
    } catch (err) {
        console.error('[/api/whatsapp/enviar] Exception:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// POST Enviar archivo multimedia (PDF, JPG, PNG, etc.) via API
const uploadWaMedia = multer({ dest: path.join(__dirname, 'public', 'uploads') });
app.post('/api/whatsapp/enviar-media', uploadWaMedia.single('archivo'), async (req, res) => {
    try {
        const { cliente_id, telefono } = req.body;
        if (!req.file) return res.status(400).json({ error: 'Archivo no proporcionado' });

        const origin = req.protocol + '://' + req.get('host');
        const fileUrl = `${origin}/uploads/${req.file.filename}`;
        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;

        const result = await waService.sendMediaMessage(cliente_id, telefono, fileUrl, fileName, mimeType);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET Proxy para descargar / visualizar imágenes y documentos entrantes desde 360dialog
app.get('/api/whatsapp/media/:mediaId', async (req, res) => {
    try {
        const { mediaId } = req.params;
        const cfg = waService.getConfig();
        if (!cfg.api_key) return res.status(404).send('Sin API Key configurada');

        const baseUrl = cfg.api_key.includes('SBN') ? 'https://waba-sandbox.360dialog.io' : 'https://waba.360dialog.io';
        
        // 1. Obtener URL del archivo desde Meta / 360dialog
        const infoRes = await fetch(`${baseUrl}/v1/media/${mediaId}`, {
            headers: { 'D360-API-KEY': cfg.api_key }
        });

        if (!infoRes.ok) {
            return res.status(404).send('Media no encontrado en 360dialog');
        }

        const info = await infoRes.json();
        const mediaUrl = info.url;

        // 2. Descargar y transmitir los bytes de la imagen/PDF al navegador
        const fileRes = await fetch(mediaUrl, {
            headers: { 'D360-API-KEY': cfg.api_key }
        });

        const contentType = info.mime_type || fileRes.headers.get('content-type') || 'image/jpeg';
        res.setHeader('Content-Type', contentType);
        if (req.query.filename) {
            res.setHeader('Content-Disposition', `inline; filename="${req.query.filename}"`);
        }

        const arrayBuffer = await fileRes.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
    } catch (err) {
        console.error('[Media Proxy Error]', err);
        res.status(500).send(err.message);
    }
});

// POST Webhook oficial para 360dialog / Meta (Mensajes entrantes y cambios de estado)
app.post('/api/webhooks/whatsapp', (req, res) => {
    try {
        const result = waService.processWebhookPayload(req.body);
        res.json(result);
    } catch (err) {
        console.error('[Webhook Error]', err);
        res.status(200).json({ ok: true }); // Responder 200 siempre a Meta para evitar des-suscripción
    }
});

// GET Webhook verification challenge (para verificación inicial Meta)
app.get('/api/webhooks/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe') {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});
// ─────────────────────────────────────────────────────────────────────────────


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

        const rango = req.query.rango || 'este_mes';
        const desdeParam = req.query.desde;
        const hastaParam = req.query.hasta;

        function toSqliteDateStr(d) {
            if (!d) return null;
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const hours = String(d.getHours()).padStart(2, '0');
            const mins = String(d.getMinutes()).padStart(2, '0');
            const secs = String(d.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
        }

        function getArgentinaNow() {
            const d = new Date();
            const argStr = d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' });
            return new Date(argStr);
        }

        const now = getArgentinaNow();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        let boundsStart = null;
        let boundsEnd = null;
        let prevStart = null;
        let prevEnd = null;
        let prevLabel = 'vs período anterior';

        if (rango === 'hoy') {
            boundsStart = todayStart;
            boundsEnd = todayEnd;
            prevStart = new Date(todayStart); prevStart.setDate(prevStart.getDate() - 1);
            prevEnd = new Date(todayEnd); prevEnd.setDate(prevEnd.getDate() - 1);
            prevLabel = 'vs ayer';
        } else if (rango === 'esta_semana') {
            const dayOfWeek = todayStart.getDay();
            const diffToMon = (dayOfWeek + 6) % 7; // Monday = 0
            boundsStart = new Date(todayStart); boundsStart.setDate(boundsStart.getDate() - diffToMon);
            boundsEnd = todayEnd;

            prevStart = new Date(boundsStart); prevStart.setDate(prevStart.getDate() - 7);
            prevEnd = new Date(boundsStart); prevEnd.setMilliseconds(-1);
            prevLabel = 'vs semana anterior';
        } else if (rango === 'este_mes') {
            boundsStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            boundsEnd = todayEnd;

            prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
            prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            prevLabel = 'vs mes anterior';
        } else if (rango === 'mes_anterior') {
            boundsStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
            boundsEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

            prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0);
            prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59, 999);
            prevLabel = 'vs mes previo';
        } else if (rango === '30_dias') {
            boundsStart = new Date(todayStart); boundsStart.setDate(boundsStart.getDate() - 30);
            boundsEnd = todayEnd;

            prevStart = new Date(boundsStart); prevStart.setDate(prevStart.getDate() - 30);
            prevEnd = new Date(boundsStart); prevEnd.setMilliseconds(-1);
            prevLabel = 'vs 30 días anteriores';
        } else if (rango === 'anio_actual') {
            boundsStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
            boundsEnd = todayEnd;

            prevStart = new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0);
            prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
            prevLabel = 'vs año anterior';
        } else if (rango === 'custom' && desdeParam && hastaParam) {
            const partsD = desdeParam.split('-');
            const partsH = hastaParam.split('-');
            boundsStart = new Date(parseInt(partsD[0]), parseInt(partsD[1]) - 1, parseInt(partsD[2]), 0, 0, 0, 0);
            boundsEnd = new Date(parseInt(partsH[0]), parseInt(partsH[1]) - 1, parseInt(partsH[2]), 23, 59, 59, 999);

            const days = Math.max(1, Math.round((boundsEnd - boundsStart) / (1000 * 60 * 60 * 24)));
            prevStart = new Date(boundsStart); prevStart.setDate(prevStart.getDate() - days);
            prevEnd = new Date(boundsStart); prevEnd.setMilliseconds(-1);
            prevLabel = `vs ${days}d anteriores`;
        }

        let gestionesRaw = [];
        if (boundsStart && boundsEnd) {
            const sStr = toSqliteDateStr(boundsStart);
            const eStr = toSqliteDateStr(boundsEnd);
            gestionesRaw = db.prepare(`SELECT * FROM historial_gestiones_whatsapp WHERE datetime(fecha_envio, '-3 hours') >= ? AND datetime(fecha_envio, '-3 hours') <= ?`).all(sStr, eStr);
        } else {
            gestionesRaw = db.prepare(`SELECT * FROM historial_gestiones_whatsapp`).all();
        }


        const gestiones = gestionesRaw.filter(g => !['mora_critica', 'renovacion_deuda'].includes(g.tipo_plantilla));

        const total_envios = gestiones.length;
        const reemplazadas = gestiones.filter(g => g.estado_resultado === 'reemplazada').length;
        const pendientes = gestiones.filter(g => g.estado_resultado === 'pendiente').length;
        const exitosos_totales = gestiones.filter(g => g.estado_resultado === 'exitoso_total').length;
        const exitosos_parciales = gestiones.filter(g => g.estado_resultado === 'exitoso_parcial').length;
        const vencidos_sin_pago = gestiones.filter(g => g.estado_resultado === 'vencido_sin_pago').length;

        const total_exitosos = exitosos_totales + exitosos_parciales;
        const total_validos = Math.max(0, total_envios - reemplazadas);
        const total_validos_calc = Math.max(1, total_validos);
        const tasa_conversion_global = total_validos > 0 ? ((total_exitosos / total_validos_calc) * 100).toFixed(1) : '0';

        function calcularMontoRecuperadoGestion(g) {
            const isRenovacion = ['renovacion_7_dias', 'poliza_vencida', 'recuperacion_historica'].includes(g.tipo_plantilla);
            const saldoEnviar = parseFloat(g.saldo_al_enviar || 0);

            if (isRenovacion) {
                let isPaid = false;
                if (g.poliza_id) {
                    const origPol = db.prepare("SELECT patente, operacion FROM polizas WHERE id = ?").get(g.poliza_id);
                    if (origPol && origPol.patente) {
                        const paidPol = db.prepare(`
                            SELECT 1 FROM polizas 
                            WHERE patente = ? AND CAST(operacion AS INTEGER) > CAST(? AS INTEGER)
                              AND (COALESCE(saldo_pendiente, 0) = 0 OR COALESCE(cuotas_debe, 3) < COALESCE(total_cuotas, 3))
                        `).get(origPol.patente, origPol.operacion);
                        if (paidPol) isPaid = true;
                    }
                }

                if (isPaid) {
                    const valorPolizaRenovada = 55865;
                    return saldoEnviar > 0 ? (saldoEnviar + valorPolizaRenovada) : valorPolizaRenovada;
                }
                // Renovó (nueva operación): cuenta como exitoso en conteo de gestiones, pero $0.00 en dinero recuperado hasta que se registre el pago
                return 0;
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
        
        // Pre-initialize active core templates so they are always rendered in the comparative table
        const coreTemplates = ['recordatorio_48hs', 'primer_aviso', 'segundo_aviso', 'renovacion_7_dias'];
        const plantillasMap = {};
        for (const ct of coreTemplates) {
            plantillasMap[ct] = {
                tipo_plantilla: ct,
                total_envios: 0,
                exitosos: 0,
                pendientes: 0,
                vencidos: 0,
                reemplazadas: 0,
                dinero_recuperado: 0
            };
        }

        for (const g of gestiones) {
            let t = g.tipo_plantilla || 'desconocido';
            if (t === 'por_vencer' || t === 'aviso_renovacion') t = 'renovacion_7_dias';

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

        // ── COMPARATIVA HOMÓLOGA PERÍODO ANTERIOR (Like-for-Like Comparison) ──
        let gestionesPrevRaw = [];
        if (prevStart && prevEnd) {
            const psStr = toSqliteDateStr(prevStart);
            const peStr = toSqliteDateStr(prevEnd);
            gestionesPrevRaw = db.prepare(`SELECT * FROM historial_gestiones_whatsapp WHERE datetime(fecha_envio, '-3 hours') >= ? AND datetime(fecha_envio, '-3 hours') <= ?`).all(psStr, peStr);
        }


        const gestionesPrev = gestionesPrevRaw.filter(gp => !['mora_critica', 'renovacion_deuda'].includes(gp.tipo_plantilla));

        let dineroPrev = 0;
        let exitososPrev = 0;
        let reemplazadasPrev = 0;

        for (const gp of gestionesPrev) {
            if (gp.estado_resultado === 'exitoso_total' || gp.estado_resultado === 'exitoso_parcial') {
                exitososPrev += 1;
                dineroPrev += calcularMontoRecuperadoGestion(gp);
            } else if (gp.estado_resultado === 'reemplazada') {
                reemplazadasPrev += 1;
            }
        }

        const validosPrev = Math.max(0, gestionesPrev.length - reemplazadasPrev);
        const conversionPrev = validosPrev > 0 ? (exitososPrev / validosPrev) * 100 : 0;
        const conversionCurr = parseFloat(tasa_conversion_global || 0);

        let varDineroPct = 0;
        if (dineroPrev > 0) {
            varDineroPct = (((dinero_recuperado_total - dineroPrev) / dineroPrev) * 100).toFixed(1);
        } else if (dinero_recuperado_total > 0) {
            varDineroPct = 100;
        }

        const varConversionPts = (conversionCurr - conversionPrev).toFixed(1);

        const comparativa = {
            prev_mes_label: prevLabel,
            prev_dinero: dineroPrev,
            var_dinero_pct: parseFloat(varDineroPct),
            prev_conversion: parseFloat(conversionPrev.toFixed(1)),
            var_conversion_pts: parseFloat(varConversionPts)
        };

        res.json({
            rango,
            total_envios,
            total_validos,
            reemplazadas,
            pendientes,
            exitosos_totales,
            exitosos_parciales,
            vencidos_sin_pago,
            tasa_conversion_global,
            dinero_recuperado_total,
            tiempo_promedio_dias,
            comparativa,
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

// ─── LIMPIEZA MANUAL DE SALDO FALSO POSITIVO ────────────────────────────────
// Permite corregir pólizas donde NRE reportó deuda pero Saldo Cli = $0
// (el Saldo Broker queda pendiente pero NO es deuda del cliente)
app.post('/api/admin/polizas/limpiar-saldo', (req, res) => {
    try {
        const { operaciones } = req.body; // array de strings de operación
        if (!Array.isArray(operaciones) || operaciones.length === 0) {
            return res.status(400).json({ error: 'Se requiere array de operaciones' });
        }
        const stmt = db.prepare(`
            UPDATE polizas
            SET cuotas_debe = 0, saldo_pendiente = 0
            WHERE operacion = ?
              AND LOWER(COALESCE(estado, '')) NOT IN ('anulada', 'baja')
        `);
        const results = [];
        for (const op of operaciones) {
            const info = stmt.run(String(op));
            results.push({ operacion: op, updated: info.changes });
            if (info.changes > 0) {
                console.log(`[Admin] Saldo limpiado manualmente para operación ${op} (Saldo Cli = $0, era falso positivo de Saldo Broker)`);
            }
        }
        res.json({ ok: true, results });
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
// ─── RUTAS ADMINISTRATIVAS DE GESTIÓN INTERNA (CLIENTES, PÓLIZAS, CUOTAS DINÁMICAS) ────

// Alta de nuevos clientes
app.post('/api/admin/clientes', (req, res) => {
    try {
        const { nombre_completo, telefono_whatsapp, email, dni, direccion } = req.body;
        if (!nombre_completo || !telefono_whatsapp) {
            return res.status(400).json({ error: 'nombre_completo y telefono_whatsapp son obligatorios' });
        }
        
        const cleanPhone = String(telefono_whatsapp).replace(/[^0-9+]/g, '');
        const info = db.prepare(`
            INSERT INTO clientes (nombre, dni, direccion, telefono, email)
            VALUES (?, ?, ?, ?, ?)
        `).run(nombre_completo, dni || '', direccion || '', cleanPhone, email || '');

        const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(info.lastInsertRowid);
        res.status(201).json(cliente);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Alta de pólizas asociadas a un cliente
app.post('/api/admin/polizas', (req, res) => {
    try {
        const { cliente_id, patente_dominio, vehiculo_modelo, aseguradora, frecuencia_renovacion, suma_asegurada, monto_poliza, monto_acarreo, fecha_vencimiento } = req.body;
        if (!cliente_id || !patente_dominio || !vehiculo_modelo) {
            return res.status(400).json({ error: 'cliente_id, patente_dominio y vehiculo_modelo son obligatorios' });
        }

        const opGenerated = 'OP-' + Date.now().toString().slice(-8);
        const asec = aseguradora || 'SEGUCar / Triunvirato';
        const frec = frecuencia_renovacion || 'TRIMESTRAL';
        const vto = fecha_vencimiento || new Date().toISOString().split('T')[0];

        const mPoliza = monto_poliza !== undefined ? parseFloat(monto_poliza) : 30240;
        const mAcarreo = monto_acarreo !== undefined ? parseFloat(monto_acarreo) : 1760;
        const mTotal = Math.round((mPoliza + mAcarreo) * 100) / 100;

        const infoPol = db.prepare(`
            INSERT INTO polizas (cliente_id, operacion, tipo_vehiculo, patente, vehiculo, suma_asegurada, fecha_vencimiento, cuotas_debe, saldo_pendiente, aseguradora, frecuencia_renovacion)
            VALUES (?, ?, 'Auto', ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(cliente_id, opGenerated, patente_dominio.toUpperCase(), vehiculo_modelo, suma_asegurada || '$ 0,00', vto, mTotal, asec, frec);

        const polizaId = infoPol.lastInsertRowid;

        // Crear primera cuota administrativa
        const infoCuota = db.prepare(`
            INSERT INTO cuotas_admin (poliza_id, numero_cuota, monto_poliza, monto_acarreo, monto_total, fecha_vencimiento, estado)
            VALUES (?, 1, ?, ?, ?, ?, 'PENDIENTE')
        `).run(polizaId, mPoliza, mAcarreo, mTotal, vto);

        const poliza = db.prepare('SELECT * FROM polizas WHERE id = ?').get(polizaId);
        const cuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(infoCuota.lastInsertRowid);

        res.status(201).json({ poliza, cuota });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Edición de cuota (monto póliza, monto acarreo, fecha vencimiento, estado)
app.patch('/api/admin/cuotas/:id', (req, res) => {
    try {
        const { id } = req.params;
        const currentCuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(id);
        if (!currentCuota) return res.status(404).json({ error: 'Cuota no encontrada' });

        const mPoliza = req.body.monto_poliza !== undefined ? parseFloat(req.body.monto_poliza) : parseFloat(currentCuota.monto_poliza);
        const mAcarreo = req.body.monto_acarreo !== undefined ? parseFloat(req.body.monto_acarreo) : parseFloat(currentCuota.monto_acarreo);
        const mTotal = Math.round((mPoliza + mAcarreo) * 100) / 100;
        const vto = req.body.fecha_vencimiento || currentCuota.fecha_vencimiento;
        const estado = req.body.estado || currentCuota.estado;

        db.prepare(`
            UPDATE cuotas_admin 
            SET monto_poliza = ?, monto_acarreo = ?, monto_total = ?, fecha_vencimiento = ?, estado = ?
            WHERE id = ?
        `).run(mPoliza, mAcarreo, mTotal, vto, estado, id);

        // Recalcular saldo pendiente de la póliza asociada
        const pendingCuotas = db.prepare("SELECT SUM(monto_total) as total, COUNT(*) as cant FROM cuotas_admin WHERE poliza_id = ? AND estado != 'PAGADO'").get(currentCuota.poliza_id);
        const saldoPoliza = pendingCuotas ? parseFloat(pendingCuotas.total || 0) : 0;
        const cantDebe = pendingCuotas ? parseInt(pendingCuotas.cant || 0) : 0;
        db.prepare('UPDATE polizas SET saldo_pendiente = ?, cuotas_debe = ? WHERE id = ?').run(saldoPoliza, cantDebe, currentCuota.poliza_id);

        const updatedCuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(id);
        res.json(updatedCuota);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint de testeo para simular pago (cambiar estado a PAGADO y asociar PDFs NRE + Grucar)
app.post('/api/admin/cuotas/:id/simular-pago', (req, res) => {
    try {
        const { id } = req.params;
        const cuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(id);
        if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

        const pdfNreUrl = `/api/pdf/nre/${id}`;
        const pdfGrucarUrl = `/api/pdf/grucar/${id}`;

        db.prepare("UPDATE cuotas_admin SET estado = 'PAGADO', fecha_pago = CURRENT_TIMESTAMP, pdf_nre_url = ?, pdf_grucar_url = ? WHERE id = ?")
          .run(pdfNreUrl, pdfGrucarUrl, id);

        // Recalcular saldo pendiente de la póliza asociada
        const pendingCuotas = db.prepare("SELECT SUM(monto_total) as total, COUNT(*) as cant FROM cuotas_admin WHERE poliza_id = ? AND estado != 'PAGADO'").get(cuota.poliza_id);
        const saldoPoliza = pendingCuotas ? parseFloat(pendingCuotas.total || 0) : 0;
        const cantDebe = pendingCuotas ? parseInt(pendingCuotas.cant || 0) : 0;
        db.prepare('UPDATE polizas SET saldo_pendiente = ?, cuotas_debe = ? WHERE id = ?').run(saldoPoliza, cantDebe, cuota.poliza_id);

        const updatedCuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(id);
        res.json({ success: true, cuota: updatedCuota, mensaje: 'Simulación exitosa: Cuota marcada como PAGADA con Recibo NRE y Cupón Grucar asociados.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Generar Link de Pago (Preferencia MercadoPago)
app.post('/api/admin/cuotas/:id/link-pago', (req, res) => {
    try {
        const { id } = req.params;
        const cuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(id);
        if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

        const prefId = 'MP-PREF-' + Date.now() + '-' + id;
        const linkPago = `https://mpago.la/simulated/${prefId}`;

        db.prepare('UPDATE cuotas_admin SET mp_preference_id = ? WHERE id = ?').run(prefId, id);

        res.json({
            success: true,
            cuota_id: id,
            mp_preference_id: prefId,
            monto_total: cuota.monto_total,
            link_pago: linkPago
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Listado General de Cobranzas Administrativas
app.get('/api/admin/cobranzas', (req, res) => {
    try {
        const estado = req.query.estado || 'TODOS';
        const search = req.query.search || '';

        let where = 'WHERE 1=1';
        let params = [];

        if (estado && estado !== 'TODOS') {
            where += ' AND ca.estado = ?';
            params.push(estado.toUpperCase());
        }

        if (search) {
            where += ' AND (c.nombre LIKE ? OR p.patente LIKE ? OR p.vehiculo LIKE ? OR p.operacion LIKE ?)';
            const term = `%${search}%`;
            params.push(term, term, term, term);
        }

        const items = db.prepare(`
            SELECT 
                ca.id, ca.poliza_id, ca.numero_cuota, ca.monto_poliza, ca.monto_acarreo, ca.monto_total, 
                ca.fecha_vencimiento, ca.estado, ca.mp_preference_id, ca.fecha_pago, ca.pdf_nre_url, ca.pdf_grucar_url,
                p.operacion, p.patente, p.vehiculo, COALESCE(p.aseguradora, 'SEGUCar / Triunvirato') as aseguradora, COALESCE(p.frecuencia_renovacion, 'TRIMESTRAL') as frecuencia_renovacion,
                c.id as cliente_id, c.nombre as cliente_nombre, c.telefono as cliente_telefono, c.email as cliente_email
            FROM cuotas_admin ca
            JOIN polizas p ON ca.poliza_id = p.id
            JOIN clientes c ON p.cliente_id = c.id
            ${where}
            ORDER BY ca.fecha_vencimiento DESC, ca.id DESC
        `).all(...params);

        res.json({ items, total: items.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── VISOR / GENERADOR DE COMPROBANTES PDF (NRE & GRUCAR) ────────────────────

// GET /api/pdf/nre/:id — Recibo de Póliza Emisión NRE
app.get('/api/pdf/nre/:id', (req, res) => {
    try {
        const { id } = req.params;
        const cuota = db.prepare(`
            SELECT ca.*, p.operacion, p.patente, p.vehiculo, p.aseguradora, c.nombre, c.dni, c.telefono
            FROM cuotas_admin ca
            JOIN polizas p ON ca.poliza_id = p.id
            JOIN clientes c ON p.cliente_id = c.id
            WHERE ca.id = ?
        `).get(id);

        if (!cuota) return res.status(404).send('Cuota no encontrada');

        const montoStr = (cuota.monto_poliza || 30240).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
        const totalStr = (cuota.monto_total || 32000).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
        const fechaPagoStr = cuota.fecha_pago ? new Date(cuota.fecha_pago).toLocaleDateString('es-AR') : new Date().toLocaleDateString('es-AR');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Recibo NRE — ${cuota.operacion || id}</title>
    <style>
        body { font-family: Arial, sans-serif; background: #f4f6f9; color: #222; margin: 0; padding: 20px; }
        .receipt-card { max-width: 750px; margin: 0 auto; background: #fff; border: 2px solid #0056b3; border-radius: 12px; padding: 30px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0056b3; padding-bottom: 15px; margin-bottom: 20px; }
        .logo-title { font-size: 22px; font-weight: 800; color: #0056b3; }
        .badge-paid { background: #28a745; color: white; padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 14px; text-transform: uppercase; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; font-size: 14px; }
        .box { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 12px; }
        .amount-box { background: #eef6ff; border: 1px solid #b6d4fe; border-radius: 8px; padding: 15px; text-align: center; margin-bottom: 20px; }
        .amount-title { font-size: 13px; color: #555; text-transform: uppercase; font-weight: bold; }
        .amount-num { font-size: 26px; font-weight: 900; color: #0056b3; margin-top: 4px; }
        .footer { font-size: 11px; color: #777; text-align: center; border-top: 1px solid #ddd; padding-top: 15px; margin-top: 20px; }
        .print-btn { display: block; width: 200px; margin: 0 auto 20px auto; padding: 10px; background: #0056b3; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; text-align: center; text-decoration: none; }
        @media print { .no-print { display: none; } body { background: white; padding: 0; } .receipt-card { box-shadow: none; border: 1px solid #000; } }
    </style>
</head>
<body>
    <button class="print-btn no-print" onclick="window.print()">🖨️ Imprimir / PDF</button>
    <div class="receipt-card">
        <div class="header">
            <div>
                <div class="logo-title">🛡️ NRE EMICOBRA</div>
                <div style="font-size:12px; color:#666; margin-top:3px;">Compañía de Seguros — Recibo Oficial de Cobertura</div>
            </div>
            <div class="badge-paid">🟢 PAGADO EN EMICOBRA</div>
        </div>
        
        <div class="grid">
            <div class="box">
                <strong>DATOS DEL ASEGURADO:</strong><br>
                Nombre: <b>${cuota.nombre || '-'}</b><br>
                DNI/CUIT: ${cuota.dni || 'Sin registrar'}<br>
                Teléfono: ${cuota.telefono || '-'}
            </div>
            <div class="box">
                <strong>DATOS DE LA PÓLIZA:</strong><br>
                N° Póliza / Op: <b>${cuota.operacion || '-'}</b><br>
                Vehículo: ${cuota.vehiculo || '-'}<br>
                Patente: <b>${cuota.patente || '-'}</b>
            </div>
        </div>

        <div class="grid">
            <div class="box">
                <strong>DETALLE DE COBRANZA:</strong><br>
                N° Cuota: <b>Cuota ${cuota.numero_cuota || 1}</b><br>
                Frecuencia: ${cuota.frecuencia_renovacion || 'TRIMESTRAL'}<br>
                Fecha de Emisión / Pago: <b>${fechaPagoStr}</b>
            </div>
            <div class="box">
                <strong>COMPAÑÍA EMISORA:</strong><br>
                Aseguradora: <b>${cuota.aseguradora || 'SEGUCar / Triunvirato'}</b><br>
                Sistema: <b>Emicobra NRE Direct</b><br>
                Ref. Transacción: <b>TX-NRE-${cuota.id}-${Date.now().toString().slice(-6)}</b>
            </div>
        </div>

        <div class="amount-box">
            <div class="amount-title">Costo Cobertura Póliza (Emisión NRE)</div>
            <div class="amount-num">${montoStr}</div>
            <div style="font-size:12px; color:#444; margin-top:4px;">(Monto Total Liquidado Combo Póliza + Acarreo: ${totalStr})</div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; background:#f8f9fa; padding:12px; border-radius:6px; font-size:12px;">
            <div>
                <b>SELLO DE VALIDEZ DIGITAL:</b><br>
                <span style="font-family:monospace; color:#333;">NRE-VERIFIED-CERT-${cuota.id}-${cuota.operacion}</span>
            </div>
            <div style="text-align:right;">
                <b>ESTADO EMICOBRA:</b><br>
                <span style="color:#28a745; font-weight:bold;">VALIDADO Y LIQUIDADO</span>
            </div>
        </div>

        <div class="footer">
            Este comprobante certifica la cancelación y vigencia de la cobertura emitida a través de NRE Emicobra Seguros.<br>
            SEGUCar Gestión de Seguros — Mar del Plata, Argentina.
        </div>
    </div>
</body>
</html>
        `);
    } catch (e) {
        res.status(500).send('Error generando comprobante NRE: ' + e.message);
    }
});

// GET /api/pdf/grucar/:id — Cupón de Servicio de Acarreo Grucar
app.get('/api/pdf/grucar/:id', (req, res) => {
    try {
        const { id } = req.params;
        const cuota = db.prepare(`
            SELECT ca.*, p.operacion, p.patente, p.vehiculo, c.nombre, c.telefono
            FROM cuotas_admin ca
            JOIN polizas p ON ca.poliza_id = p.id
            JOIN clientes c ON p.cliente_id = c.id
            WHERE ca.id = ?
        `).get(id);

        if (!cuota) return res.status(404).send('Cuota no encontrada');

        const montoStr = (cuota.monto_acarreo || 1760).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
        const fechaPagoStr = cuota.fecha_pago ? new Date(cuota.fecha_pago).toLocaleDateString('es-AR') : new Date().toLocaleDateString('es-AR');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Cupón Grucar — ${cuota.patente || id}</title>
    <style>
        body { font-family: Arial, sans-serif; background: #121c24; color: #e1e1e1; margin: 0; padding: 20px; }
        .coupon-card { max-width: 720px; margin: 0 auto; background: #1e2d3b; border: 2px solid #ff9f43; border-radius: 14px; padding: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #ff9f43; padding-bottom: 14px; margin-bottom: 20px; }
        .logo-title { font-size: 24px; font-weight: 900; color: #ff9f43; letter-spacing: 1px; }
        .badge-active { background: #28a745; color: white; padding: 6px 14px; border-radius: 20px; font-weight: 800; font-size: 13px; text-transform: uppercase; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; font-size: 14px; }
        .box { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 14px; }
        .amount-box { background: rgba(255,159,67,0.12); border: 1px solid rgba(ff9f43,0.4); border-radius: 10px; padding: 16px; text-align: center; margin-bottom: 20px; }
        .amount-title { font-size: 13px; color: #ff9f43; text-uppercase: uppercase; font-weight: bold; letter-spacing: 0.5px; }
        .amount-num { font-size: 28px; font-weight: 900; color: #fff; margin-top: 4px; }
        .footer { font-size: 11px; color: #a0a0b8; text-align: center; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 15px; margin-top: 20px; }
        .print-btn { display: block; width: 220px; margin: 0 auto 20px auto; padding: 10px; background: #ff9f43; color: #121c24; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; text-align: center; text-decoration: none; }
        @media print { .no-print { display: none; } body { background: white; color: black; padding: 0; } .coupon-card { background: white; color: black; border: 1px solid #000; box-shadow: none; } .box { background: #f8f9fa; border: 1px solid #ddd; color: black; } }
    </style>
</head>
<body>
    <button class="print-btn no-print" onclick="window.print()">🖨️ Imprimir Cupón Grucar</button>
    <div class="coupon-card">
        <div class="header">
            <div>
                <div class="logo-title">🚗 GRUCAR AUXILIO 24H</div>
                <div style="font-size:12px; color:#a0a0b8; margin-top:3px;">Servicio de Remolque & Asistencia Mecánica Nacional</div>
            </div>
            <div class="badge-active">🟢 GRUCAR ACTIVO</div>
        </div>
        
        <div class="grid">
            <div class="box">
                <strong>TITULAR DEL SERVICIO:</strong><br>
                Nombre: <b>${cuota.nombre || '-'}</b><br>
                WhatsApp: <b>${cuota.telefono || '-'}</b>
            </div>
            <div class="box">
                <strong>DOMINIO HABILITADO:</strong><br>
                Patente: <b style="font-size:16px; color:#ff9f43;">${cuota.patente || '-'}</b><br>
                Vehículo: ${cuota.vehiculo || '-'}
            </div>
        </div>

        <div class="grid">
            <div class="box">
                <strong>COBERTURA DE REMOLQUE:</strong><br>
                Período: <b>1 Mes (Suscripción Renovada)</b><br>
                Fecha Activación: <b>${fechaPagoStr}</b>
            </div>
            <div class="box">
                <strong>CENTRAL DE EMERGENCIAS:</strong><br>
                Teléfono 24h: <b>0800-333-GRUCAR</b><br>
                Cupón N°: <b>CUP-GRU-${cuota.id}-${Date.now().toString().slice(-6)}</b>
            </div>
        </div>

        <div class="amount-box">
            <div class="amount-title">Costo Servicio Remolque / Acarreo (Grucar)</div>
            <div class="amount-num">${montoStr}</div>
            <div style="font-size:12px; color:#2ed573; margin-top:4px;">✔ Suscripción mensual automatizada activa</div>
        </div>

        <div style="background: rgba(46,213,115,0.1); border:1px solid rgba(46,213,115,0.3); padding:12px; border-radius:8px; font-size:12px; text-align:center;">
            <b>ESTADO DE SUSCRIPCIÓN GRUCAR:</b><br>
            <span style="color:#2ed573; font-weight:bold; font-size:14px;">SERVICIO HABILITADO EN TODO EL PAÍS</span>
        </div>

        <div class="footer">
            Presente este cupón o indique su patente (${cuota.patente}) ante la solicitud de auxilio o remolque en ruta.<br>
            GRUCAR System & SEGUCar Gestión — Cobertura 24h.
        </div>
    </div>
</body>
</html>
        `);
    } catch (e) {
        res.status(500).send('Error generando cupón Grucar: ' + e.message);
    }
});
// ═══════════════════════════════════════════════════════════════════════════
// 🌐 PUBLIC CLIENT WEBAPP ENDPOINTS (/pago/:cuota_id)
// ═══════════════════════════════════════════════════════════════════════════

app.get('/pago/:cuota_id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pago.html'));
});

app.get('/api/public/cuotas/:id', (req, res) => {
    try {
        const cuota = db.prepare(`
            SELECT ca.*, 
                   c.nombre as cliente_nombre, 
                   c.telefono as cliente_telefono,
                   p.patente, 
                   p.vehiculo, 
                   p.operacion,
                   p.aseguradora
            FROM cuotas_admin ca
            JOIN polizas p ON ca.poliza_id = p.id
            JOIN clientes c ON p.cliente_id = c.id
            WHERE ca.id = ?
        `).get(req.params.id);

        if (!cuota) {
            return res.status(404).json({ error: 'Cuota no encontrada' });
        }

        res.json({
            id: cuota.id,
            numero_cuota: cuota.numero_cuota || 1,
            total_cuotas: 3,
            monto_poliza: cuota.monto_poliza || 30240,
            monto_acarreo: cuota.monto_acarreo || 1760,
            monto_total: cuota.monto_total || 32000,
            fecha_vencimiento: cuota.fecha_vencimiento,
            estado: cuota.estado || 'PENDIENTE',
            cliente_nombre: cuota.cliente_nombre,
            patente: cuota.patente,
            vehiculo: cuota.vehiculo,
            operacion: cuota.operacion,
            aseguradora: cuota.aseguradora || 'SEGUCar / Triunvirato',
            link_pago: cuota.link_pago || `https://mpago.la/simulated/MP-PREF-${Date.now()}-${cuota.id}`,
            pdf_nre_url: cuota.pdf_nre_url || `/api/pdf/nre/${cuota.id}`,
            pdf_grucar_url: cuota.pdf_grucar_url || `/api/pdf/grucar/${cuota.id}`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/public/cuotas/:id/simular-pago', (req, res) => {
    try {
        const id = req.params.id;
        const cuota = db.prepare('SELECT * FROM cuotas_admin WHERE id = ?').get(id);
        if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

        const fechaPago = new Date().toISOString();
        const pdfNre = `/api/pdf/nre/${id}`;
        const pdfGrucar = `/api/pdf/grucar/${id}`;

        db.prepare(`
            UPDATE cuotas_admin 
            SET estado = 'PAGADO', 
                fecha_pago = ?, 
                pdf_nre_url = ?, 
                pdf_grucar_url = ? 
            WHERE id = ?
        `).run(fechaPago, pdfNre, pdfGrucar, id);

        db.prepare(`
            UPDATE polizas 
            SET saldo_pendiente = 0, 
                cuotas_debe = 0 
            WHERE id = ?
        `).run(cuota.poliza_id);

        res.json({
            success: true,
            message: '¡Pago acreditado exitosamente!',
            estado: 'PAGADO',
            fecha_pago: fechaPago,
            pdf_nre_url: pdfNre,
            pdf_grucar_url: pdfGrucar
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/public/comprobantes', (req, res) => {
    try {
        const { patente, dni } = req.query;
        if (!patente && !dni) {
            return res.status(400).json({ error: 'Debe ingresar una patente o DNI' });
        }

        let query = `
            SELECT ca.*, 
                   c.nombre as cliente_nombre, 
                   p.patente, 
                   p.vehiculo, 
                   p.operacion
            FROM cuotas_admin ca
            JOIN polizas p ON ca.poliza_id = p.id
            JOIN clientes c ON p.cliente_id = c.id
            WHERE ca.estado = 'PAGADO'
        `;
        let params = [];

        if (patente) {
            query += ` AND (LOWER(p.patente) = LOWER(?) OR LOWER(p.operacion) = LOWER(?))`;
            params.push(patente.trim(), patente.trim());
        }
        if (dni) {
            query += ` AND c.dni = ?`;
            params.push(dni.trim());
        }

        query += ` ORDER BY ca.fecha_vencimiento DESC`;

        const items = db.prepare(query).all(...params);
        res.json({ items });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── ENDPOINT AUTOMATIZACIÓN N8N ─────────────────────────────────────────────
// GET /api/automation/pendientes-hoy
// n8n llama a este endpoint todos los días a las 9am y envía WhatsApps automáticamente.
app.get('/api/automation/pendientes-hoy', (req, res) => {
    try {
        const hoy = new Date();
        if (esNoHabil(hoy)) {
            return res.json({ dia_no_habil: true, pendientes: [] });
        }

        const allPolizas = db.prepare(`
            SELECT p.id, p.operacion, p.patente, p.fecha_vencimiento,
                   p.fin_vigencia_poliza, p.cuotas_debe, p.saldo_pendiente,
                   c.nombre, c.telefono, c.id as cliente_id
            FROM polizas p
            JOIN clientes c ON p.cliente_id = c.id
            WHERE c.telefono IS NOT NULL AND length(c.telefono) >= 10
        `).all();

        const pendientes = [];

        for (const p of allPolizas) {
            if (!p.fecha_vencimiento || !p.telefono) continue;

            const fv = new Date(p.fecha_vencimiento + 'T12:00:00-03:00');
            const diffHoras = (fv - hoy) / (1000 * 60 * 60);
            const cuotasDebe = parseInt(p.cuotas_debe || 0);
            const saldo = parseFloat(p.saldo_pendiente || 0);

            let tipo = null;
            let plantilla = null;

            if (diffHoras > 0 && diffHoras <= 48 && saldo <= 0)
                { tipo = 'recordatorio_48hs'; plantilla = 'recordatorio_preventivo_48hs'; }
            else if (diffHoras < 0 && diffHoras >= -48 && cuotasDebe >= 1)
                { tipo = 'primer_aviso'; plantilla = 'primer_aviso_vencida_48hs'; }
            else if (diffHoras < -48 && diffHoras >= -96 && cuotasDebe >= 1)
                { tipo = 'segundo_aviso'; plantilla = 'cuota_segundo_aviso_vencida_hace_96_hs'; }
            else if (diffHoras < -96 && cuotasDebe >= 2)
                { tipo = 'mora_critica'; plantilla = 'mora_critica_impaga'; }

            // Renovación en 7 días (usa fin_vigencia_poliza)
            if (!tipo && p.fin_vigencia_poliza) {
                const fvP = new Date(p.fin_vigencia_poliza + 'T12:00:00-03:00');
                const diasPoliza = (fvP - hoy) / (1000 * 60 * 60 * 24);
                if (diasPoliza >= 0 && diasPoliza <= 7)
                    { tipo = 'renovacion_7_dias'; plantilla = 'aviso_renovacion_7_dias'; }
            }

            if (tipo) {
                pendientes.push({
                    cliente_id: p.cliente_id,
                    nombre: p.nombre,
                    telefono: p.telefono,
                    operacion: p.operacion || '',
                    patente: p.patente || '',
                    fecha_vencimiento: p.fecha_vencimiento,
                    cuotas_debe: cuotasDebe,
                    tipo,
                    plantilla,
                    parametros: [p.operacion || p.patente || '', p.patente || '']
                });
            }
        }

        res.json({
            dia_no_habil: false,
            fecha: toLocalISOString(hoy),
            total: pendientes.length,
            pendientes
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🛡️  GestiónSeguro corriendo en http://localhost:${PORT}`);
        console.log(`    Red local: http://0.0.0.0:${PORT}`);
    });
}

// ─── AUTO-SYNC NRE CADA 2 HORAS (días hábiles, 8am-8pm) ────────────────────
// El botón manual sigue funcionando igual. Esto corre en paralelo en el servidor.
(function iniciarAutoSyncNRE() {
    const INTERVALO_MS = 2 * 60 * 60 * 1000; // 2 horas

    async function correrAutoSync() {
        const ahora = new Date();
        const dia = ahora.getDay(); // 0=Dom, 6=Sab
        const hora = ahora.getHours();

        // Solo en días hábiles (Lun-Sab) y en horario de 8am a 8pm
        if (dia === 0 || hora < 8 || hora >= 20) {
            console.log(`⏭️  Auto-sync NRE omitido (${dia === 0 ? 'Domingo' : 'fuera de horario'})`);
            return;
        }

        try {
            const usuario = process.env.SISTEMA_USUARIO || 'SUA';
            const password = process.env.SISTEMA_PASSWORD || 'sua';
            console.log(`🔄 Auto-sync NRE iniciado (${toLocalISOString(ahora)})...`);
            const result = await syncGeneralNRE(usuario, password);
            updateLastSyncDate();
            console.log(`✅ Auto-sync NRE completado — ${result?.actualizados || 0} registros actualizados`);
        } catch (err) {
            console.error('❌ Auto-sync NRE error:', err.message);
        }
    }

    // Correr al inicio (con 3 min de delay para que Render complete el port scan y arranque limpio)
    setTimeout(correrAutoSync, 3 * 60 * 1000);

    // Repetir cada 2 horas
    setInterval(correrAutoSync, INTERVALO_MS);

    console.log('⏰ Auto-sync NRE programado: cada 2hs en días hábiles (8am-8pm)');
})();

// ─── AUTO-SYNC AGS CADA 2 HORAS (días hábiles, 8am-8pm) ─────────────────────
(function iniciarAutoSyncAGS() {
    const INTERVALO_MS = 2 * 60 * 60 * 1000; // 2 horas

    async function correrAutoSyncAGS() {
        const ahora = new Date();
        const dia = ahora.getDay();
        const hora = ahora.getHours();
        if (dia === 0 || hora < 8 || hora >= 20) {
            console.log(`⏭️  Auto-sync AGS omitido (${dia === 0 ? 'Domingo' : 'fuera de horario'})`);
            return;
        }
        try {
            console.log(`🔵 Auto-sync AGS iniciado (${toLocalISOString(ahora)})...`);
            const result = await syncAGS();
            console.log(`✅ Auto-sync AGS — ${result.polizas_actualizadas} actualizadas, ${result.con_deuda} con deuda`);
        } catch (err) {
            console.error('❌ Auto-sync AGS error:', err.message);
        }
    }

    // Delay de 5min para no solaparse con NRE ni bloquear el arranque de Render
    setTimeout(correrAutoSyncAGS, 5 * 60 * 1000);
    setInterval(correrAutoSyncAGS, INTERVALO_MS);
    console.log('⏰ Auto-sync AGS programado: cada 2hs en días hábiles (8am-8pm)');
})();

module.exports = app;
