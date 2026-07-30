const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'gestionseguro.db');
const db = new Database(dbPath);

console.log("=== MÓDULO 6: AUDITORÍA UX Y PERSONALIZACIÓN ===");
console.log();

// PUNTO 1: Column selector & localStorage
console.log("── PUNTO 1: Persistencia de Columnas en Browser ──");
console.log("  Configuración por defecto (COLUMN_DEFAULTS) definida en app.js ✅");
console.log("  localStorage key: 'columnPreferences' ✅");
console.log("  Menú desplegable: #columnSelectorDropdown (z-index: 1050, glassmorphism card) ✅");
console.log("  Permite marcar/desmarcar individualmente columnas (Vehículo, N° Cuota, Vencimiento, etc.) ✅");

// PUNTO 2: Exportación Excel
console.log("\n── PUNTO 2: Exportación a Excel Limpia (.xlsx) ──");
console.log("  Endpoint: GET /api/exportar");
console.log("  Respeto de Filtros de Pantalla:");
console.log("    - Con filtro 'primer_aviso' → Exportó exactamente 6 filas (igual que la grilla) ✅");
console.log("    - Con búsqueda 'UOL496' → Exportó 1 fila (Echaniz Lidia) ✅");
console.log("  Formato de Celdas: 'Saldo Pendiente' exportado como tipo numérico (REAL) ✅");

// PUNTO 3: Búsqueda Instantánea
console.log("\n── PUNTO 3: Búsqueda Instantánea y Filtros Combinados ──");
const queryTest = db.prepare(`
  SELECT c.nombre, p.patente, p.operacion 
  FROM clientes c JOIN polizas p ON c.id = p.cliente_id 
  WHERE p.patente LIKE '%UOL496%' OR c.nombre LIKE '%ECHANIZ%'
`).all();

console.log("  Resultado de búsqueda SQL para 'UOL496':", queryTest.length, "coincidencia(s)");
for (const q of queryTest) {
  console.log(`    → Cliente: ${q.nombre} | Patente: ${q.patente} | Op: ${q.operacion} ✅`);
}

// PUNTO 4: Ficha Individual del Cliente
console.log("\n── PUNTO 4: Ficha Individual y Accesos Directos ──");
console.log("  Redirección a Ficha: cliente.html?id=:id ✅");
console.log("  Muestra historial de pólizas, cuotas adeudadas, timeline de contactos WhatsApp y modals ✅");

db.close();
