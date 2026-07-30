# Reglas Estrictas de Desarrollo (GestiónSeguro / SEGUCar)

## 1. REGLA DE NO REGRESIÓN DE SQL
Cuando modifiques consultas SQL en `server.js` (`/api/clientes`, `/api/renovaciones`, etc.), **NUNCA** elimines los `JOIN`s con las tablas de pólizas/vehículos. La respuesta JSON debe mantener obligatoriamente las propiedades:
* `patente`
* `vehículo` (o `vehiculo`)
* `póliza` (o `operacion`)
* `vencimiento` (o `fecha_vencimiento`)
* `nro_cuota`
* `importe_pendiente` (o `saldo_pendiente`)

## 2. REGLA DE FILTRADO POR SALDO
Cualquier consulta de cobranzas en mora **DEBE** incluir de forma obligatoria la condición:
`AND saldo_pendiente > 0`
Si `saldo_pendiente` es `<= 0` (o `$0,00`), la póliza pertenece exclusivamente al estado `'Al Día'` (`AL_DIA`) y **DEBE** ser ignorada para el cálculo de mora y excluida de los listados activos de cobranza.

## 3. REGLA DE DÍAS HÁBILES Y ZONA HORARIA
* El cálculo de días entre fechas debe realizarse usando objetos `Date` en hora local de Argentina (no `toISOString()` / UTC) y descontando fines de semana cuando corresponda para el cálculo operativo de la mora.
* Las comparaciones contra la fecha actual deben ser dinámicas usando `CURRENT_DATE()` o `new Date()` locales (ej: `date('now', 'localtime')` en SQLite). **NUNCA** utilices fechas hardcodeadas o fijas en el código para clasificaciones o sincronización.

## 4. CHECKLIST PRE-COMMIT
Antes de generar la explicación de cualquier cambio, realiza una verificación exhaustiva en el frontend/API para asegurar que no se hayan reemplazado campos poblados por valores nulos, vacíos o guiones (`'-'`).
