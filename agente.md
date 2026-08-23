# 🤖 AGENTE.MD — Manual Maestro de Arquitectura, Reglas de Negocio, Automatizaciones y Guía del Proyecto

Este documento consolida todo el conocimiento técnico, decisiones de arquitectura, casos de borde resueltos, reglas de negocio, estrategias y restricciones del proyecto **SEGUCar**. 

Cualquier agente de IA o desarrollador que intervenga en esta base de código **DEBE consultar y respetar este archivo** como la única fuente de verdad para mantener la integridad del sistema.

---

## 📑 Índice
1. [Contexto Crítico y Lo que NO debe redescubrirse](#1-contexto-crítico-y-lo-que-no-debe-redescubrirse)
2. [Historial de Casos Reales y Bugs Resueltos](#2-historial-de-casos-reales-y-bugs-resueltos)
3. [Estructura del Proyecto y Módulos](#3-estructura-del-proyecto-y-módulos)
4. [Stack Tecnológico y Hosting (Render vs GitHub)](#4-stack-tecnológico-y-hosting-render-vs-github)
5. [Arquitectura de Automatización: n8n + IA + 360dialog](#5-arquitectura-de-automatización-n8n--ia--360dialog)
6. [Estrategia Comercial de Cartera y Segmento Camiones](#6-estrategia-comercial-de-cartera-y-segmento-camiones)
7. [Convenciones de Código y Buenas Prácticas](#7-convenciones-de-código-y-buenas-prácticas)
8. [Comandos de Ejecución y Testing](#8-comandos-de-ejecución-y-testing)
9. [QUÉ NO HACER (Prohibiciones Estrictas)](#9-qué-no-hacer-prohibiciones-estrictas)

---

## 1. Contexto Crítico y Lo que NO debe redescubrirse

### 🏢 Portales Aseguradoras y Scraping
1. **NRE (Triunvirato Seguros - Servidor Emisión `http://149.50.137.101/emision`)**:
   - `lisvtopol.php`: Listado de pólizas y vigencias de contrato trimestrales.
   - `lisdeupmo.php`: Listado de deudas generales. ⚠️ **Alerta**: Este reporte lista deuda a nivel contable de agencia/broker. Puede incluir pólizas que el asegurado ya pagó si la rendición del broker sigue abierta.
   - `muestro-polizas.php?prop={op}`: **ÁRBITRO SUPREMO DE VERDAD**.
     - `Saldo Cli`: Saldo real adeudado por el asegurado. Si es `$0,00`, el cliente está al día.
     - `Saldo Broker`: Deuda interna de intermediario. **PROHIBIDO usar para alertar al cliente**.
     - Pestaña `Pagos`: Registra recibos oficiales con fecha, número de recibo e importe.
   - `traigo-polizas.php`: Búsqueda histórica de operaciones por patente o asegurado.

2. **AGS (Agrosalta - `https://www.agsnet.com.ar`)**:
   - Facturación en **4 cuotas fijas** por contrato (`total_cuotas = 4`).
   - Sin servicio de auxilio mecánico Grucar (`grucar_activo = 0`).
   - Códigos de productor activos: `123701054` y `123901054`.
   - Endpoint de vigencias: `consulvigprod3.php`.

### 🚗 Composición de Cuota y Regla del Remanente `<= $2.500` (Grucar)
- Una cuota típica de NRE se compone de: **Prima de Seguro ($30.240)** + **Auxilio Mecánico Grucar ($1.760 - $2.000)** = Total **$32.240**.
- **Regla del Remanente (`<= $2.500`)**: Cuando el cliente abona los $30.240 de la prima principal y en NRE queda un saldo de $2.000 (auxilio no rendido o diferencia menor):
  1. La cobertura de seguro está **100% ACTIVA y PAGADA**.
  2. La cuota se considera **cumplida**.
  3. El sistema avanza automáticamente la fecha de vencimiento a la **siguiente cuota principal**.
  4. **NUNCA** disparar alertas de *Segundo Aviso* ni *Mora Crítica* (suspensión de cobertura) por saldos menores a `$2.500`.

### 🔄 Regla de Reemplazo por Renovación
- Cuando una póliza vence y se renueva en NRE, se emite una operación con **número secuencial mayor** (`CAST(operacion AS INTEGER)` más alto).
- La nueva operación **anula y reemplaza** a todas las operaciones anteriores de esa misma patente.
- Toda consulta SQL o filtro de pólizas deduplicadas **DEBE ordenar por `CAST(operacion AS INTEGER) DESC`** (nunca `ASC`).

### 📅 Calendario de Cobranza y Días Hábiles en Argentina
- **SEGUCar TRABAJA LOS SÁBADOS**.
- Días no laborables: **Domingos y Feriados Nacionales de Argentina** (`holidays_ar.js`).
- En domingos y feriados se pausan los envíos masivos de recordatorios y primer aviso.
- **Recordatorio Preventivo (48 hs exactas - `calDiff === 2`)**:
  - 📅 **Miércoles** ➔ Cuotas del Viernes
  - 📅 **Jueves** ➔ Cuotas del Sábado
  - 📅 **Viernes** ➔ Cuotas del Domingo ⚠️ *(Los vencimientos de domingo NUNCA se avisan en jueves)*
  - 📅 **Sábado** ➔ Cuotas del Lunes

---

## 2. Historial de Casos Reales y Bugs Resueltos

| Caso / Cliente | Problema Detectado | Causa Raíz | Solución Definitiva |
|---|---|---|---|
| **Sosa Hector / Varas Jesica** | Aparecía póliza vieja impaga a pesar de haber renovado y pagado. | La consulta ordenaba por `operacion ASC` y tomaba la más antigua; además el rango del sync no cubría el año siguiente. | Se forzó orden `CAST(operacion AS INTEGER) DESC` y se amplió el sync a `curYear + 1`. |
| **Vencimientos de Domingo en Jueves** | Los recordatorios de cuotas de domingo se mostraban el jueves (72 hs antes) y el viernes (48 hs antes). | `holidays_ar.js` tenía una regla `calDiff === 3 && esNoHabil(vtoNominal)` que evaluaba domingo como no hábil en jueves. | Se eliminó el disparador de 3 días; el recordatorio es estrictamente `calDiff === 2`. |
| **Medina Mario Guillermo** | Aparecía en renovaciones de 7 días sin teléfono tras haber renovado su auto. | Tiene 3 vehículos distintos (Voyage, Moto Brava 110 y Gol Trend). La moto vencía en 7 días y vino con espacios triples (`MEDINA   MARIO GUILLERMO`). | Se unificaron las fichas de clientes heredando el teléfono válido `5492233391173` y normalizando espacios múltiples. |
| **Rodriguez Laura / Arecha / Fenoy** | Figuraban en *Primer Aviso* con cuotas que ya habían pagado. | `syncPagosNRE` salteaba pólizas listadas en `lisdeupmo.php` (deuda broker) y tenía tope de 60 candidatos. | Se auditó en vivo `muestro-polizas.php` (`Saldo Cli`), purgando 52 pólizas saldadas, y se eliminó la exclusión. |
| **Bertolot Daniel (`Op. 12015621`)** | Recibió mensaje de *"suspensión de cobertura (96 hs)"* habiendo pagado $30.240. | La cuota era de $32.240 (con $2.000 de Grucar). Al restar $2.000, el sistema la trató como mora crítica. | Se implementó la regla `<= $2.500` en `holidays_ar.js`, `server.js` y `stateManager.js`, avanzando el vencimiento a Cuota 2. |
| **Tabla Vacía con Badge en 16** | La tarjeta mostraba 16 clientes pero la tabla decía *"No se encontraron resultados"*. | `getFechasTargetCobranza` evaluaba fechas con un saldo dummy de `$100`, que era absorbido por la nueva regla `<= $2.500`. | Se corrigió el saldo de evaluación de fechas a `$35.000` y se ocultó el emptyState duplicado. |

---

## 3. Estructura del Proyecto y Módulos

```
gestion-seguro/
├── server.js               # Servidor Express, endpoints REST, scheduler cron de auto-sync
├── database.js             # Conexión SQLite, esquemas, índices de rendimiento y helpers
├── sync_nre.js             # Scraping e integración con NRE (Triunvirato)
├── sync_ags.js             # Scraping e integración con AGS (Agrosalta)
├── holidays_ar.js          # Manejo de calendario hábil argentino y evaluador de cobranzas
├── whatsapp_service.js     # Integración Meta WhatsApp Business API Cloud / 360dialog
├── config.json             # Personalización de marca (Whitelabel)
│
├── public/                 # Frontend Web SPA
│   ├── index.html          # Vistas (Dashboard, Cobranza, Renovaciones, Métricas)
│   ├── css/                # Estilos visuales
│   └── js/
│       ├── app.js          # Orquestador UI, renderizado de tablas y filtros
│       ├── stateManager.js # Máquina de estados de clientes y pólizas
│       ├── cliente.js      # Modal de ficha de cliente, historial y cuotas
│       ├── metrics.js      # Reportes analíticos de cartera
│       └── whatsapp_inbox.js # Bandeja de entrada de WhatsApp
│
├── data/
│   ├── gestionseguro.db    # Base de datos SQLite
│   └── last_sync.json      # Registro de última sincronización
│
└── test/
    └── regression_suite.js # Suite de regresión automatizada (4/4 tests de blindaje)
```

---

## 4. Stack Tecnológico y Hosting (Render vs GitHub)

- **Node.js** + **Express.js**: Servidor backend.
- **better-sqlite3**: Base de datos SQLite síncrona de alto rendimiento.
- **cheerio**: Parser HTML para scraping de portales.
- **date-holidays**: Biblioteca de feriados argentinos.
- **360dialog API v2**: Mensajería oficial WhatsApp HSM y mensajes libres.

### 🌐 ¿Por qué Render y no GitHub Pages?
- **GitHub**: Almacén seguro de código fuente y control de versiones (`git push`).
- **GitHub Pages**: Solo aloja archivos estáticos (HTML/CSS/JS del navegador). **No permite backend, ni base de datos, ni cron jobs, ni webhooks**.
- **Render**: Servidor en la nube prendido 24/7 que ejecuta Node.js, persiste la base de datos SQLite, corre sincronizaciones automáticas cada hora y escucha webhooks de WhatsApp en tiempo real.

---

## 5. Arquitectura de Automatización: n8n + IA + 360dialog

```
[📲 WhatsApp Entrante] ➔ [🏢 360dialog / Meta] ➔ [🌐 Webhook n8n]
                                                        ⬇
                                        [❓ ¿Atendido por Humano o IA?]
                                           ├── 👤 Humano ➔ [Queda en bandeja]
                                           └── 🤖 IA ➔ [🧠 AI Agent (GPT-4o-mini)]
                                                            ├── 🔍 Consultar Deuda (/api/clientes)
                                                            ├── 💳 Enviar Alias (SEGUCAR.SEGUROS)
                                                            ├── 🚗 Cotizar Vehículo
                                                            └── 🙋‍♂️ Handoff a Operador
```

### 📋 Prompt Maestro para el Bot de n8n:
```text
Sos el Asistente Virtual Oficial de SEGUCar (Productor Asesor de Seguros).
Tu objetivo es brindar atención rápida, cordial y precisa por WhatsApp.

CAPACIDADES:
1. CONSULTA DE DEUDA: Usa la herramienta 'ConsultarClienteSEGUCar' con el teléfono del cliente.
   - Datos bancarios oficiales: Alias: SEGUCAR.SEGUROS | Titular: Lisandro Suarez.
2. COTIZACIONES: Solicita Marca, Modelo, Año, si tiene GNC y Localidad.
3. RENOVACIONES: Confirma la patente y notifica que se gestiona la reemisión.
4. PASE A HUMANO (HANDOFF): Si el cliente reporta un choque/siniestro, envía comprobante de pago o pide hablar con una persona, responde amablemente y transfiere la conversación.
```

---

## 6. Estrategia Comercial de Cartera y Segmento Camiones

### 📊 Cartera Actual:
- **Total Pólizas Activas:** **`1.796`**
- 🚗 **Autos:** 1.361 (75,8%)
- 🛻 **Pick Ups / Utilitarios:** 230 (12,8%)
- 🏍️ **Motos:** 161 (9,0%)
- 🚛 **Camiones de Reparto Local:** 44 (2,4%)

### 🎯 Estrategia de Crecimiento en Pesados (Sin Grúa Propia):
1. **Posicionamiento por Precio Directo:** Cuota mensual de RC Comercial más económica del mercado al no cargar sobrecostos de grúas pesadas que no responden.
2. **Billetera de Control Instantánea:** Certificado de cobertura y recibo en PDF offline en la App en 1 segundo (evita que el fletero pierda viajes en controles o entradas a predios).
3. **Directorio SOS Pesados:** Acuerdos locales con 2 talleres/grúas pesadas de guardia derivados desde la App (costo $0).
4. **Cross-Selling con los 230 Utilitarios:** Mensaje a dueños de F-100, Kangoo y Hilux para asegurar sus camiones comerciales con tarifa bonificada.

---

## 7. Convenciones de Código y Buenas Prácticas

1. **Zona Horaria:** Usar siempre `getArgentinaNow()` de `holidays_ar.js` (`America/Argentina/Buenos_Aires`). Render corre en UTC.
2. **Deduplicación de Clientes:** Normalizar nombres con `replace(/\s+/g, ' ')` y heredar siempre teléfonos válidos (`COALESCE(NULLIF(telefono, ''), ...)`).
3. **Validación Preflight:** Todo envío de WhatsApp debe consultar previamente `/api/whatsapp/preflight`.
4. **Manejo de Transacciones:** Usar `db.transaction(() => { ... })()` para operaciones en lote en SQLite.

---

## 8. Comandos de Ejecución y Testing

```bash
# Iniciar servidor
npm start

# Ejecutar Suite de Regresión Automatizada (4/4 tests de blindaje)
npm test
```

---

## 9. QUÉ NO HACER (Prohibiciones Estrictas)

1. ❌ **NO usar `Saldo Broker` para evaluar moras**: Evaluar siempre `Saldo Cli` de `muestro-polizas.php`.
2. ❌ **NO disparar recordatorios de cuotas de domingo en días jueves**: Se avisan únicamente el **Viernes (48 hs antes)**.
3. ❌ **NO clasificar en mora ni suspender cobertura por saldos `<= $2.500`**: Si pagó la póliza principal ($30.240), el remanente de auxilio se considera al día y avanza a la siguiente cuota.
4. ❌ **NO ordenar pólizas por `operacion ASC`**: La póliza activa de una patente es siempre la de **mayor número de operación**.
5. ❌ **NO enviar mensajes sin pasar por `preflight`**: Debe validarse siempre `/api/whatsapp/preflight`.
6. ❌ **NO hardcodear números de prueba menores a `$2.500` en funciones de target**: `getFechasTargetCobranza` debe usar `$35.000`.
7. ❌ **NO usar `new Date().getDay()` en backend sin conversión de zona horaria**: Provoca desfasajes de domingo a partir de las 21:00 hs ARG.
8. ❌ **NO desincronizar `stateManager.js` (frontend) de `holidays_ar.js` (backend)**: Los códigos de estado deben coincidir exactamente.
