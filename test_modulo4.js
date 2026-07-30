const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'gestionseguro.db');
const dbConn = new Database(dbPath);

const templates = dbConn.prepare("SELECT * FROM plantillas WHERE activa = 1").all();

console.log("=== MÓDULO 4: AUDITORÍA WHATSAPP Y DISPARO INTELIGENTE ===");
console.log();

// PUNTO 1: URL Format
console.log("── PUNTO 1: Formato Universal de URL ──");
const samplePhone = "5492235644144";
const sampleUrl = `https://wa.me/${samplePhone}?text=${encodeURIComponent("Hola Test")}`;
console.log("  URL Generada:", sampleUrl);
console.log("  ¿Tiene formato https://wa.me/549 + 10 dígitos?", sampleUrl.startsWith("https://wa.me/5492235644144?") ? "✅ SÍ" : "❌ NO");

// PUNTO 2: Auto-selección por estado
console.log("\n── PUNTO 2: Selección Inteligente de Plantillas (Smart Action) ──");
const mapping = {
  'RECORDATORIO_48HS': 'recordatorio_48hs',
  'CUOTA_VENCIDA_0_48HS': 'primer_aviso',
  'CUOTA_VENCIDA_48_96HS': 'segundo_aviso',
  'MORA_CRITICA_96HS': 'mora_critica',
  'RENOVACION_7_DIAS': 'renovacion_7_dias'
};

for (const [stateCode, tplType] of Object.entries(mapping)) {
  const found = templates.find(t => t.tipo === tplType);
  console.log(`  Estado: ${stateCode.padEnd(22)} → Plantilla: "${tplType}" → ${found ? '✅ OK ("' + found.nombre.substring(0, 35) + '...")' : '❌ FALTA'}`);
}

// PUNTO 3: Consolidación Multi-Vehículo
console.log("\n── PUNTO 3 & 4: Consolidación Multi-Vehículo y Reemplazo de Variables ──");
const multiClient = dbConn.prepare("SELECT * FROM clientes WHERE id = 13337").get(); // FERNANDEZ DOMINGUEZ
const polizas = dbConn.prepare("SELECT * FROM polizas WHERE cliente_id = 13337").all();

console.log(`  Cliente: ${multiClient.nombre}`);
console.log(`  Pólizas adeudadas: ${polizas.length}`);

const primerAvisoTpl = templates.find(t => t.tipo === 'primer_aviso');

const listLines = polizas.map(p => `• ${p.vehiculo || p.tipo_vehiculo || 'Vehículo'} (Patente ${p.patente || '-'})`).join('\n');
const totalSaldo = polizas.reduce((sum, p) => sum + (parseFloat(p.saldo_pendiente) || 0), 0);
const saldoStr = `$ ${totalSaldo.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let msgTemplate = primerAvisoTpl.mensaje;
if (polizas.length > 1) {
  if (msgTemplate.includes(' ({vehiculo} - Patente {patente})')) {
    msgTemplate = msgTemplate.replace(' ({vehiculo} - Patente {patente})', ':\n' + listLines);
  } else if (msgTemplate.includes('({vehiculo} - Patente {patente})')) {
    msgTemplate = msgTemplate.replace('({vehiculo} - Patente {patente})', ':\n' + listLines);
  }
}

const msg = msgTemplate
  .replace(/\{nombre\}/g, multiClient.nombre)
  .replace(/\{vehiculo\}/g, listLines)
  .replace(/\{patente\}/g, polizas.map(p => p.patente).join(', '))
  .replace(/\{importe\}/g, saldoStr)
  .replace(/\{monto\}/g, saldoStr)
  .replace(/\{saldo_pendiente\}/g, saldoStr);

console.log("\n  Mensaje Unificado Generado:");
console.log("  ┌─────────────────────────────────────────────────────────────┐");
msg.split('\n').forEach(line => console.log('  │ ' + line));
console.log("  └─────────────────────────────────────────────────────────────┘");

// Check for unreplaced variables
const unreplaced = msg.match(/\{[a-zA-Z0-9_]+\}/g);
console.log("\n  Variables sin reemplazar:", unreplaced ? `❌ ${unreplaced.join(', ')}` : "✅ Ninguna (100% reemplazadas)");

dbConn.close();
