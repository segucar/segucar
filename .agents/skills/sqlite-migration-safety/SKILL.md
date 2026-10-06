---
name: sqlite-migration-safety
description: >-
  Guía de seguridad, integridad y migraciones en SQLite con better-sqlite3.
  Regula la preservación de base de datos viva (no sobreescribir con seed.db),
  transacciones atómicas, función norm() y backups en data/backups/.
---

# 🗄️ Procedimientos de Integridad y Migración SQLite (`better-sqlite3`)

Esta skill establece las pautas de ingeniería para interactuar con el motor de base de datos local SQLite (`gestionseguro.db`) de forma segura y consistente.

## 🔒 1. Protección de Datos Vivos vs `seed.db`
- **Regla Inmutable:** `seed.db` **SOLO** debe copiarse hacia `gestionseguro.db` si el archivo de base de datos **no existe** (`!fs.existsSync(dbPath)`).
- **Prohibido:** Copiar `seed.db` sobre una base existente en reinicios del servidor, ya que destruiría los datos sincronizados y el historial operativo.

## ⚡ 2. Concurrencia y Rendimiento (Modo WAL)
- Siempre verificar que los siguientes pragmas estén activos:
  ```javascript
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  ```
- **Transacciones Atómicas:** Para inserciones o actualizaciones en lote (sync, importaciones Excel/VCF, imputaciones masivas), envolver siempre el bloque en:
  ```javascript
  const executeBatch = db.transaction((items) => {
      for (const item of items) { /* ... */ }
  });
  executeBatch(items);
  ```

## 🔤 3. Búsqueda y Normalización de Texto (`norm()`)
- SQLite por defecto no maneja correctamente acentos, diacríticos ni la letra eñe (`Ñ`) con el operador `LIKE`.
- Usar siempre la función personalizada `norm()` registrada en SQLite:
  ```sql
  -- Ejemplo de búsqueda segura:
  WHERE norm(c.nombre) LIKE '%' || norm(?) || '%'
     OR norm(p.patente) LIKE '%' || norm(?) || '%'
  ```

## 🛡️ 4. Pólizas Anuladas e Historial
- Para evaluar si una póliza está dada de baja o anulada, usar siempre el helper unificado:
  ```javascript
  // Valida anulada = 1, estado = 'anulada' o estado_nre = 'Anulada'
  db.esPolizaAnulada(poliza);
  ```
- Toda consulta que involucre vigencias o cartera activa debe excluir expresamente pólizas anuladas.
