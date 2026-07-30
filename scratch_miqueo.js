const fs = require('fs');
const xlsx = require('xlsx');

const excelPath = '/Users/tomassuares/.gemini/antigravity/scratch/gestion-seguro/Emision_listado_de_vencimientos.xlsx';
const workbook = xlsx.readFile(excelPath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

console.log("Searching Excel by patentes (SII498, AGE714) or DNI (37240188) or numbers 64-4144...");
for (const r of rows) {
    const rowStr = JSON.stringify(r).toUpperCase();
    if (rowStr.includes('SII498') || rowStr.includes('AGE714') || rowStr.includes('37240188') || rowStr.includes('4144')) {
        console.log("Matched Row:", JSON.stringify(r));
    }
}
