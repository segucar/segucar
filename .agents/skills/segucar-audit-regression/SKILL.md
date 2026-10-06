---
name: segucar-audit-regression
description: >-
  Auditoría sistemática e integral del sistema SEGUCar. Ejecuta y valida la suite de
  regresión (32/32 tests), verifica la integridad referencial de SQLite, comprueba
  consistencia de cuotas y saldos de cobranzas, y genera reportes de salud técnica y comercial.
---

# 🛡️ SEGUCar Audit & Regression Skill

Esta skill define el procedimiento estándar para auditar la integridad del sistema SEGUCar, prevenir regresiones antes de cada despliegue y verificar periódicamente la salud de los datos.

## 📋 Cuándo Activar esta Skill
- Cuando el usuario solicite "hacer una auditoría", "verificar el sistema", o "chequear la base de datos".
- Antes y después de realizar cambios sustanciales en `server.js`, `database.js`, `sync_nre.js`, `sync_ags.js` o `holidays_ar.js`.
- Durante la ejecución del control semanal automático.

## 🛠️ Procedimiento de Auditoría Paso a Paso

### 1. Ejecución de la Suite de Regresión (Blindaje 32/32)
Ejecutar siempre la suite automatizada para validar que ninguna regla histórica se haya roto:
```bash
npm test
```
**Criterio de Aprobación:** Debe retornar `🏆 SUITE DE REGRESIÓN: 32/32 PASSED — SISTEMA BLINDADO Y OPERATIVO`.

Si algún test falla:
- Si falla **Test 31**: Revisar que los portales NRE/AGS nunca muten cuotas a PAGADA automáticamente por saldo $0 contable.
- Si falla **Test 32**: Revisar `nre_payment_detector.js` y confirmar que `infoFecha.es_lote_administrativo` esté evaluado y el interruptor maestro (`activo: false`) se respete.
- Si falla **Test 24**: Revisar el manejo de domingos y feriados en `holidays_ar.js`.
- Si falla **Test 28**: Revisar paridad exacta entre `/api/dashboard/stats` y `/api/metricas/resumen`.

### 2. Verificación de Integridad de Base de Datos
Consultar en `gestionseguro.db`:
1. **Pólizas Huérfanas:** `SELECT COUNT(*) FROM polizas WHERE cliente_id NOT IN (SELECT id FROM clientes);` -> Debe ser `0`.
2. **Patentes Duplicadas Activas:** Pólizas no anuladas con misma patente -> Debe ser `0` (la más reciente por `operacion DESC` es la única activa).
3. **Consistencia de Deuda:**
   - Pólizas con `saldo_pendiente > 2500` y `cuotas_debe = 0` o `NULL`.
   - Pólizas con `saldo_pendiente <= 2500` pero `cuotas_debe > 0`.
   - Pólizas con saldos negativos (`saldo_pendiente < 0`).
4. **Estado de Teléfonos:** Proporción de clientes con teléfonos de 10+ dígitos numéricos válidos.

### 3. Verificación de Seguridad y Trazabilidad
- Comprobar que `nre_payment_detector.js` mantenga `activo: false` en producción.
- Validar que las credenciales sensibles (`.env`, `D360_API_KEY`) no estén expuestas en logs ni repositorios públicos.
- Confirmar que la tabla `auditoria_pagos_cuotas` esté lista para registrar imputaciones manuales de oficina.

### 4. Generación de Reporte Semanal
Guardar el resumen de hallazgos en `data/reportes_auditoria/reporte_semanal_YYYY-MM-DD.md`.
