---
name: ags-cronograma-sync
description: >-
  Protocolo de integración, generación de cronogramas y sincronización de pólizas de
  Agrosalta (AGS). Regula el cronograma mensual de 4 cuotas fijas, cuota activa, ausencia
  de grúa Grucar y uso de helpers desacoplados sin dependencias circulares.
---

# 🔵 Gestor de Contratos y Cronogramas Agrosalta (AGS)

Esta skill contiene las especificaciones de arquitectura y reglas de negocio para operar con la aseguradora **Agrosalta (AGS)** (`https://www.agsnet.com.ar`).

## ⚙️ Reglas de Negocio Específicas de AGS

### 1. Cronograma Mensual Automático de 4 Cuotas
- Los contratos de Agrosalta se facturan en **4 cuotas fijas por contrato cuatrimestral** (`total_cuotas = 4`).
- Cada cuota vence mensualmente antes de la fecha de `fin_vigencia`:
  - **Cuota 1:** $M - 4$ meses
  - **Cuota 2:** $M - 3$ meses
  - **Cuota 3:** $M - 2$ meses
  - **Cuota 4:** $M - 1$ mes
- **Importe de cada cuota:** `premio > 0 ? premio / 4 : 0`.

### 2. Cuota Activa Operativa (Anti-Falsos Vencimientos)
- `nro_cuota` y `fecha_vencimiento` de la póliza deben apuntar a:
  1. La **primera cuota vencida e impaga** (si existe mora).
  2. O a la **próxima cuota a vencer** en el futuro (si está al día).
  3. ⚠️ **NUNCA asignar `fin_vigencia` como fecha de vencimiento de una cuota**.

### 3. Exclusiones de Servicio
- Las pólizas de AGS **no poseen servicio de auxilio mecánico Grucar** (`grucar_activo = 0`, `fecha_vencimiento_grucar = null`).
- El valor de la cuota en AGS es 100% prima aseguradora pura.

### 4. Códigos de Productor y Autenticación
- Códigos activos de productor: `123701054` y `123901054`.
- Endpoint principal de consulta de vigencias: `consulvigprod3.php`.

### 5. Desacoplamiento de Módulos (Sin Dependencia Circular)
- **Regla Estricta:** `database.js` y `sync_ags.js` **NUNCA** deben importarse mutuamente en forma directa.
- Todas las funciones puras de cálculo de cronogramas AGS (`generarCronogramaCuotasAGS`, `calcularFechaCuotaAGS`, `AGS_TOTAL_CUOTAS`) residen exclusivamente en [ags_helpers.js](file:///Users/tomassuares/Desktop/Proyectos%20antygravity/Segucar%20gestion%20interna/SEGUCar%20-%20Gestion%20Interna/ags_helpers.js).
