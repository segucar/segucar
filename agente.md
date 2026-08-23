# 🤖 AGENTE.MD — Documento Maestro de Contexto, Arquitectura y Reglas

Este archivo contiene todo el conocimiento acumulado, decisiones críticas de arquitectura, reglas de negocio y restricciones del proyecto **SEGUCar**. Cualquier agente o desarrollador que trabaje en esta base de código **DEBE leer y respetar este documento** para no reintroducir bugs ya resueltos.

---

## 📌 1. Lo que NO debe redescubrirse (Contexto Crítico del Negocio)

### 🏢 Portales Aseguradoras y Scraping
1. **NRE (Triunvirato Seguros - Servidor Emisión `http://149.50.137.101/emision`)**:
   - `lisvtopol.php`: Listado de pólizas y vencimientos de contrato (trimestral).
   - `lisdeupmo.php`: Listado general de deudas. ⚠️ **CUIDADO**: Este endpoint lista deudas a nivel broker contable; puede listar clientes que ya pagaron si la rendición del broker aún está abierta.
   - `muestro-polizas.php?prop={op}`: **FUENTE SUPREMA DE VERDAD**. Contiene la tabla de cuotas individuales:
     - `Saldo Cli`: Lo que **realmente debe el asegurado**. Si es `$0,00`, el cliente está al día.
     - `Saldo Broker`: Deuda del intermediario con la compañía. **NUNCA usar para alertar al cliente**.
     - Pestaña `Pagos`: Muestra los recibos oficiales emitidos con fecha e importe.
   - `traigo-polizas.php`: Búsqueda histórica de operaciones por patente o cliente.
2. **AGS (Agrosalta - `https://www.agsnet.com.ar`)**:
   - Factura en **4 cuotas fijas** por póliza (`total_cuotas = 4`).
   - No utiliza auxilio mecánico Grucar (`grucar_activo = 0`).
   - Endpoint `consulvigprod3.php`: Pólizas vigentes por productor (`123701054`, `123901054`).

### 🚗 Composición de Cuota y Remanente de Auxilio (Grucar)
- Una cuota de automotor en NRE suele componerse de: **Prima de Emisión ($30.240)** + **Auxilio Mecánico Grucar ($1.760 - $2.000)** = Total **$32.240**.
- **Regla del Remanente `<= $2.500`**: Cuando el cliente abona el 100% de la prima principal ($30.240) y en NRE queda un saldo residual de `$2.000` (auxilio Grucar), **la cobertura del seguro está ACTIVA y PAGADA**.
- **PROHIBIDO** clasificar una póliza en *Segundo Aviso* o *Mora Crítica* (suspensión de cobertura) por un remanente menor `<= $2.500`.

### 🔄 Regla de Reemplazo por Renovación (Deduplicación por Patente)
- Cuando una póliza vence y se reemite/renueva, NRE genera un **número de operación más alto** (`CAST(operacion AS INTEGER)` mayor).
- **Regla Inquebrantable**: La póliza más nueva **anula y reemplaza** a todas las anteriores de esa misma patente.
- En queries y vistas activas, la deduplicación **SIEMPRE ordena por `CAST(operacion AS INTEGER) DESC`** (nunca `ASC`, ya que `ASC` retenía la póliza vieja).

### 📅 Días Hábiles, Feriados y Sábados (Argentina)
- **SEGUCar TRABAJA LOS SÁBADOS**.
- Días no laborables: **Domingos y Feriados Nacionales de Argentina** (`holidays_ar.js`).
- En días no hábiles (domingos/feriados), los envíos masivos de avisos preventivos y primer aviso se pausan (`esNoHabil = true`).
- **Recordatorio Preventivo (48 hs exactas)**:
  - 📅 **Miércoles** ➔ Cuotas del Viernes (`calDiff = 2`)
  - 📅 **Jueves** ➔ Cuotas del Sábado (`calDiff = 2`)
  - 📅 **Viernes** ➔ Cuotas del Domingo (`calDiff = 2`) ⚠️ *(Los del domingo NUNCA se avisan en jueves)*
  - 📅 **Sábado** ➔ Cuotas del Lunes (`calDiff = 2`)

---

## 💻 2. Stack Tecnológico

- **Backend Runtime**: Node.js (v18+ / v20+ / v24+).
- **Framework Web**: Express.js (REST API + Servidor de archivos estáticos).
- **Base de Datos**: SQLite 3 mediante `better-sqlite3` (síncrono, ultrarrápido y seguro en transacciones).
- **Web Scraping & Parsing**: `cheerio` + `fetch` nativo con `fetchWithRetry` y timeout de seguridad.
- **Manejo de Feriados**: `date-holidays` (configurado para Argentina `'AR'`).
- **WhatsApp Integration**: 
  - API Oficial: Meta WhatsApp Business API Cloud / 360dialog (`waba-v2.360dialog.io/messages`).
  - Fallback: Enlace directo `web.whatsapp.com/send`.
- **Frontend**: Vanilla JavaScript modular (ES6), HTML5, CSS3 con variables de tema oscuro/moderno. Sin frameworks pesados ni bundlers obligatorios.
- **Hosting / Deploy**: Render (Web Service Node.js con base SQLite persistente en `data/`).

---

## 📁 3. Estructura del Proyecto

```
gestion-seguro/
├── server.js               # Servidor Express principal, rutas API y scheduler de sincronización
├── database.js             # Conexión SQLite, schemas, migraciones, índices y helpers
├── sync_nre.js             # Módulo de sincronización y scraping con portal NRE (Emisión Triunvirato)
├── sync_ags.js             # Módulo de sincronización con portal AGS (Agrosalta)
├── holidays_ar.js          # Lógica de días hábiles, feriados argentinos y evaluación de cobranza
├── whatsapp_service.js     # Cliente 360dialog API v2, plantillas HSM y webhook receiver
├── config.json             # Branding dinámico (Whitelabel: SEGUCar, etc.)
│
├── public/                 # Frontend servido estáticamente
│   ├── index.html          # Interfaz principal SPA (Dashboard, Cobranza, Renovaciones, Métricas)
│   ├── css/                # Hojas de estilo
│   └── js/
│       ├── app.js          # Controlador principal de UI, navegación y tablas
│       ├── stateManager.js # Máquina de estados oficial del cliente (Cobranza y Renovación)
│       ├── cliente.js      # Modal de detalle de cliente, historial de pólizas y cuotas
│       ├── metrics.js      # Gráficos y analítica de cartera
│       └── whatsapp_inbox.js # Bandeja de chat WhatsApp en vivo
│
├── data/
│   ├── gestionseguro.db    # Base de datos SQLite principal
│   └── last_sync.json      # Timestamp de última sincronización exitosa
│
└── test/
    └── regression_suite.js # Suite de pruebas de regresión automatizadas (4 tests clave)
```

---

## 📐 4. Convenciones de Código y Arquitectura

1. **Manejo de Zona Horaria**:
   - Render corre en **UTC**. Argentina es **UTC-3 (`America/Argentina/Buenos_Aires`)**.
   - Siempre usar `getArgentinaNow()` de `holidays_ar.js` o `Intl.DateTimeFormat` con timeZone `America/Argentina/Buenos_Aires`.
   - **NUNCA** asumir que `new Date().toISOString().slice(0,10)` es la fecha argentina a las 22:00 hs (en UTC ya es el día siguiente).

2. **Transacciones en Base de Datos**:
   - Usar `db.transaction(() => { ... })()` de `better-sqlite3` para inserciones y actualizaciones en lote.
   - Todo índice de búsqueda (`idx_polizas_operacion`, `idx_polizas_patente`, `idx_clientes_telefono`) debe mantenerse creado en `database.js`.

3. **Formato de Teléfonos**:
   - Formato estándar WhatsApp Argentina: `549` + 10 dígitos (ej: `5492236974883`).
   - La función `sanitizeAndFixPhone` normaliza números descartando fijos o inválidos (< 10 dígitos).

4. **Sincronización Dual (`sync_nre.js`)**:
   - `syncVencimientosNRE`: Trae vigencias y pólizas emitidas (rango `curYear - 1` a `curYear + 1`).
   - `syncDeudasNRE`: Cruza deudas generales.
   - `syncPagosNRE`: Audita en lotes concurrentes (10) `muestro-polizas.php` para verificar `Saldo Cli` real.

---

## 🏛️ 5. Decisiones de Diseño Tomadas y Justificación

| Decisión de Diseño | ¿Por qué se tomó? |
|---|---|
| **`CAST(operacion AS INTEGER) DESC`** | Las operaciones en NRE son numéricamente secuenciales. Ordenar en string o ASC hacía que el sistema mostrara la póliza vieja en lugar de la recién renovada. |
| **`muestro-polizas.php` como árbitro supremo** | `lisdeupmo.php` reporta deuda contable de broker; `muestro-polizas.php` refleja el pago inmediato del asegurado en caja/banco. |
| **Umbral de remanente `<= $2.500`** | Evita mandar alertas amenazantes de *"suspensión de cobertura"* a clientes que ya pagaron sus $30.240 de póliza y solo adeudan $2.000 de grúa. |
| **Preflight Check `/api/whatsapp/preflight`** | Antes de abrir WhatsApp o enviar un HSM, valida en milisegundos que el cliente no haya pagado en la última hora, que la póliza no esté anulada y que sea la última operación. |
| **Sábados laborables en `holidays_ar.js`** | La correduría atiende y cobra los sábados. Solo los domingos y feriados nacionales se consideran no hábiles. |

---

## 🧪 6. Comandos de Build, Start y Test

```bash
# Iniciar servidor en desarrollo / producción
npm start
# o: node server.js

# Ejecutar Suite Completa de Tests de Regresión (4/4 tests)
npm test
# o: node test/regression_suite.js
```

---

## 🚫 7. QUÉ NO HACER (Prohibiciones Estrictas)

1. ❌ **NO usar `Saldo Broker` para evaluar moras**: Siempre evaluar `Saldo Cli`.
2. ❌ **NO disparar recordatorios de cuotas de domingo en días jueves**: Las cuotas del domingo se avisan el **Viernes (48 hs antes)**.
3. ❌ **NO ordenar pólizas por `operacion ASC`**: La póliza activa de una patente es siempre la de **mayor número de operación**.
4. ❌ **NO enviar mensajes sin pasar por `preflight`**: Todo envío por WhatsApp debe validar previamente `/api/whatsapp/preflight`.
5. ❌ **NO hardcodear números de prueba menores a `$2.500` en funciones de target**: `getFechasTargetCobranza` debe usar montos realistas (`$35.000`) para no ser absorbido por el filtro de remanentes.
6. ❌ **NO usar `new Date().getDay()` para lógica de fechas en el servidor sin pasar por zona horaria Argentina**: Provoca desfasajes de domingo a partir de las 21:00 hs ARG.
7. ❌ **NO alterar la sincronía entre `stateManager.js` (frontend) y `holidays_ar.js` (backend)**: Ambos deben tener idénticos códigos de estado (`RECORDATORIO_48HS`, `CUOTA_VENCIDA_0_48HS`, `CUOTA_VENCIDA_48_96HS`, `MORA_CRITICA_96HS`, `AL_DIA`).
