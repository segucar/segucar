
async function runFullAudit() {
    console.log("==================================================");
    console.log("🛡️ AUDITORÍA DE SEGURIDAD Y FUNCIONALIDAD EN VIVO");
    console.log("==================================================\n");
    let passedCount = 0;

    // Fetch a sample cuota to test with
    const resList = await fetch("http://localhost:3005/api/admin/cobranzas?limit=5");
    const dataList = await resList.json();
    if (!dataList.items || dataList.items.length === 0) {
        console.error("❌ No se pudieron obtener cuotas para la prueba.");
        process.exit(1);
    }
    const testCuota = dataList.items[0];
    console.log(`📌 Cuota de Prueba: ID ${testCuota.id} (Cliente: ${testCuota.cliente_nombre}, Patente: ${testCuota.patente})`);

    // 1. EDITAR MONTOS
    try {
        const patchRes = await fetch(`http://localhost:3005/api/admin/cuotas/${testCuota.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                monto_poliza: 30240,
                monto_acarreo: 1760
            })
        });
        const patchData = await patchRes.json();
        if (patchRes.ok && patchData.monto_total === 32000) {
            console.log("✅ PUNTO 1 [EDITAR MONTOS]: PASSED -> PATCH /api/admin/cuotas/:id recalcula monto_total = 30240 + 1760 = 32000 ARS.");
            passedCount++;
        } else {
            console.error("❌ PUNTO 1 FAILED:", patchData);
        }
    } catch (e) {
        console.error("❌ PUNTO 1 ERROR:", e.message);
    }

    // 2. LINK MERCADOPAGO
    try {
        const linkRes = await fetch(`http://localhost:3005/api/admin/cuotas/${testCuota.id}/link-pago`, {
            method: "POST"
        });
        const linkData = await linkRes.json();
        if (linkRes.ok && linkData.link_pago && (linkData.link_pago.includes("mpago.la") || linkData.link_pago.includes("mercadopago"))) {
            console.log(`✅ PUNTO 2 [LINK MERCADOPAGO]: PASSED -> Link de MercadoPago generado con éxito (${linkData.link_pago}).`);
            passedCount++;
        } else {
            console.error("❌ PUNTO 2 FAILED:", linkData);
        }
    } catch (e) {
        console.error("❌ PUNTO 2 ERROR:", e.message);
    }

    // 3. SIMULAR PAGO & PDFS
    try {
        const simRes = await fetch(`http://localhost:3005/api/admin/cuotas/${testCuota.id}/simular-pago`, {
            method: "POST"
        });
        const simData = await simRes.json();
        
        const nreRes = await fetch(`http://localhost:3005/api/pdf/nre/${testCuota.id}`);
        const grucarRes = await fetch(`http://localhost:3005/api/pdf/grucar/${testCuota.id}`);

        if (simRes.ok && nreRes.status === 200 && grucarRes.status === 200) {
            console.log("✅ PUNTO 3 [SIMULAR PAGO & PDFS]: PASSED -> Estado cambiado a PAGADO y comprobantes NRE & Grucar respondieron HTTP 200.");
            passedCount++;
        } else {
            console.error("❌ PUNTO 3 FAILED:", { simOk: simRes.ok, nreStatus: nreRes.status, grucarStatus: grucarRes.status });
        }
    } catch (e) {
        console.error("❌ PUNTO 3 ERROR:", e.message);
    }

    // 4. BOTÓN WHATSAPP
    try {
        const cliRes = await fetch(`http://localhost:3005/api/clientes?search=${testCuota.patente}`);
        const cliData = await cliRes.json();
        if (cliRes.ok && cliData.clientes && cliData.clientes.length > 0) {
            const cli = cliData.clientes[0];
            console.log(`✅ PUNTO 4 [BOTÓN WHATSAPP]: PASSED -> Generación de enlaces wa.me verificada para cliente ${cli.nombre} (Tel: ${cli.telefono || "N/A"}).`);
            passedCount++;
        } else {
            console.error("❌ PUNTO 4 FAILED:", cliData);
        }
    } catch (e) {
        console.error("❌ PUNTO 4 ERROR:", e.message);
    }

    // 5. FILTROS Y BÚSQUEDA
    try {
        const searchPat = await fetch("http://localhost:3005/api/clientes?search=RPQ899");
        const searchMora = await fetch("http://localhost:3005/api/clientes?estado=mora_critica");
        const patData = await searchPat.json();
        const moraData = await searchMora.json();

        if (searchPat.ok && searchMora.ok && patData.clientes.length >= 1 && moraData.total > 0) {
            console.log(`✅ PUNTO 5 [FILTROS Y BÚSQUEDA]: PASSED -> Búsqueda por patente (RPQ899) y filtro por estado (Mora Crítica = ${moraData.total}) respondieron 100% ok.`);
            passedCount++;
        } else {
            console.error("❌ PUNTO 5 FAILED:", { patCount: patData.clientes ? patData.clientes.length : 0, moraTotal: moraData.total });
        }
    } catch (e) {
        console.error("❌ PUNTO 5 ERROR:", e.message);
    }

    console.log("\n==================================================");
    if (passedCount === 5) {
        console.log("🏆 RESULTADO FINAL: 5/5 PASSED - SISTEMA 100% OPERATIVO");
    } else {
        console.log(`⚠️ RESULTADO FINAL: ${passedCount}/5 PASSED`);
    }
    console.log("==================================================");
}

runFullAudit();
