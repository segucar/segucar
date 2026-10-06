---
name: nre-scraping-protocol
description: >-
  Protocolo técnico y reglas de negocio para el scraping e integración con el portal
  NRE (Triunvirato Seguros - Servidor Emisión). Define el uso de muestro-polizas.php,
  la regla del remanente Grucar <= $2.500, deduplicación de renovaciones y manejo de sesiones.
---

# 🏢 Protocolo Maestro de Scraping e Integración NRE (Triunvirato)

Este documento es la referencia estricta para cualquier intervención, módulo o script que interactúe con el portal de emisión de Triunvirato Seguros (`http://149.50.137.101/emision`).

## 🎯 Reglas Fundamentales de Extracción

### 1. El Árbitro Supremo de Verdad: `muestro-polizas.php?prop={op}`
- **Parámetro obligatorio:** `?prop={op}` (⚠️ **NUNCA** usar `?poli=`).
- **Saldo Cli:** Es el **único saldo real adeudado por el asegurado**. Si es `$0,00`, el cliente está al día y la cuota está saldada.
- **Saldo Broker:** Refleja la deuda de cuenta corriente de la agencia/intermediario. **PROHIBIDO** usar para evaluar mora o alertar al cliente.
- **Identificación de Tablas:** Parsear cabeceras `<th>` buscando `Saldo Cli` y `Cuota` (⚠️ las filas de datos **no** contienen la palabra "cuota", solo el header).

### 2. Regla Unificada del Remanente `<= $2.500` (Grucar Acarreo)
- La cuota típica es: **Prima Seguro ($30.240)** + **Auxilio Mecánico ($1.760 - $2.000)** = **$32.240**.
- Si el cliente pagó la prima y queda un saldo `<= $2.500`:
  1. La cobertura de seguro está **100% ACTIVA**.
  2. La cuota se considera **al día**.
  3. El sistema avanza automáticamente a la siguiente cuota a vencer.
  4. **NUNCA** enviar Segundo Aviso ni alertar por suspensión de cobertura ante saldos `<= $2.500`.

### 3. Deduplicación de Contratos y Renovaciones
- Cuando una póliza vence y se renueva, NRE emite una operación con **número secuencial mayor** (`CAST(operacion AS INTEGER)` más alto).
- La nueva operación reemplaza y anula operativamente a las anteriores para esa patente.
- Toda query SQL o filtro de pólizas activas **DEBE** ordenar por `CAST(operacion AS INTEGER) DESC` (nunca `ASC`).

### 4. Manejo de Sesión, Pool de Cookies y Timeouts
- La autenticación se realiza en `emivali.php` mediante POST con `useremi` y `pasemi`.
- Reutilizar el pool de cookies en memoria para evitar saturar el servidor de emisión con logins repetitivos.
- Usar siempre wrappers con reintentos (`fetchWithRetry`) y timeouts controlados (8s a 15s máx).

## 🚫 Prohibiciones Estrictas
- ❌ No filtrar cuotas por expresiones regulares genéricas sobre el cuerpo de la tabla (ej. `/cuota/i`).
- ❌ No clasificar pólizas saldadas (`Saldo Cli $0,00`) con `nro_cuota` en 1 ni con fechas de cuotas anteriores; deben llevar `nro_cuota = 3/3`, `fecha_vencimiento = fin_vigencia` y badge `🟢 Al día`.
- ❌ No asumir que una póliza listada en `lisdeupmo.php` está en mora: validar siempre contra `muestro-polizas.php`.
