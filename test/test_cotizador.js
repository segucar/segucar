/**
 * test/test_cotizador.js
 * Suite de Verificación de las 4 Capas del Cotizador NRE
 */

const { cotizarVehiculo, resolverMarcaAlias, buscarEnCache } = require('../cotizador_nre');
const db = require('../database');

async function runCotizadorTests() {
    console.log('====================================================');
    console.log('🚗 TEST SUITE: MOTOR DE COTIZACIÓN NRE (4 CAPAS)');
    console.log('====================================================\n');

    let passed = 0;
    let total = 5;

    // ── TEST 1: Alias de Marcas ─────────────────────────────────────────────
    try {
        const aliasVW = resolverMarcaAlias('vw');
        const aliasChevy = resolverMarcaAlias('chevy');
        const aliasToyota = resolverMarcaAlias('Toyota');

        if (aliasVW === 'VOLKSWAGEN' && aliasChevy === 'CHEVROLET' && aliasToyota === 'TOYOTA') {
            console.log('✅ TEST 1 PASSED -> Normalización de alias de marcas (VW, Chevy, Toyota).');
            passed++;
        } else {
            console.error('❌ TEST 1 FAILED -> Error en alias:', { aliasVW, aliasChevy, aliasToyota });
        }
    } catch (e) {
        console.error('❌ TEST 1 ERROR:', e.message);
    }

    // ── TEST 2: Cotización en Vivo con Casco Disponible (Suma <= $20M) ────────
    try {
        console.log('🔄 Ejecutando cotización en vivo para Fiat Uno 2012 (CP 7600)...');
        db.prepare("DELETE FROM cotizaciones_cache WHERE cache_key LIKE 'FIAT_UNO%'").run();

        const resLive = await cotizarVehiculo({
            marca: 'FIAT',
            modelo: 'UNO',
            anio: 2012,
            codp: '7600'
        });

        if (
            resLive.ok &&
            !resLive.fallback_humano &&
            resLive.casco_disponible_nre === true &&
            resLive.planes &&
            resLive.planes.length >= 4 &&
            resLive.planes[0].cuota_mensual === 18456 &&
            resLive.vehiculo &&
            resLive.vehiculo.suma_asegurada <= 20000000 &&
            resLive.origen === 'nre_live'
        ) {
            console.log(`✅ TEST 2 PASSED -> Cotización con Casco (SA <= $20M): Suma ${resLive.vehiculo.suma_asegurada_formato}, ${resLive.planes.length} planes disponibles (RC: ${resLive.planes[0].cuota_formato}, B1: ${resLive.planes[1].cuota_formato}).`);
            passed++;
        } else {
            console.error('❌ TEST 2 FAILED -> Inconsistencia en cotización <= $20M:', resLive);
        }
    } catch (e) {
        console.error('❌ TEST 2 ERROR:', e.message);
    }

    // ── TEST 3: Regla de Tope de Suscripción NRE (Suma > $20M -> Solo Plan A + AGS) ─
    try {
        console.log('🔄 Ejecutando cotización en vivo para Renault Sandero Stepway 2023 (CP 5000)...');
        db.prepare("DELETE FROM cotizaciones_cache WHERE cache_key LIKE 'RENAULT_SANDERO%'").run();

        const resTope = await cotizarVehiculo({
            marca: 'RENAULT',
            modelo: 'SANDERO STEPWAY',
            anio: 2023,
            codp: '5000'
        });

        if (
            resTope.ok &&
            !resTope.fallback_humano &&
            resTope.casco_disponible_nre === false &&
            resTope.sugerencia_aseguradora_casco === 'AGS' &&
            resTope.planes &&
            resTope.planes.length === 1 &&
            resTope.planes[0].codigo === 'A' &&
            resTope.planes[0].cuota_mensual === 18456 &&
            resTope.vehiculo.suma_asegurada > 20000000 &&
            resTope.casco_observacion
        ) {
            console.log(`✅ TEST 3 PASSED -> Regla Tope NRE ($20M): Suma ${resTope.vehiculo.suma_asegurada_formato} > $20M -> Solo Plan A devuelto (${resTope.planes[0].cuota_formato}) y Casco derivado a AGS.`);
            passed++;
        } else {
            console.error('❌ TEST 3 FAILED -> Falló regla de tope $20M en NRE:', resTope);
        }
    } catch (e) {
        console.error('❌ TEST 3 ERROR:', e.message);
    }

    // ── TEST 4: Verificación de Caché Local 24hs (Segunda llamada) ───────────
    try {
        const tStart = Date.now();
        const resCache = await cotizarVehiculo({
            marca: 'RENAULT',
            modelo: 'SANDERO STEPWAY',
            anio: 2023,
            codp: '5000'
        });
        const elapsed = Date.now() - tStart;

        if (
            resCache.ok &&
            resCache.origen === 'cache_local' &&
            resCache.cached_at &&
            elapsed < 50
        ) {
            console.log(`✅ TEST 4 PASSED -> Caché local 24hs validada en ${elapsed}ms (Origen: cache_local).`);
            passed++;
        } else {
            console.error('❌ TEST 4 FAILED -> No respondió desde caché local:', { resCache, elapsed });
        }
    } catch (e) {
        console.error('❌ TEST 4 ERROR:', e.message);
    }

    // ── TEST 5: Fallback Elegante a Humano ───────────────────────────────────
    try {
        const resFallback = await cotizarVehiculo({
            marca: 'MODELO_INEXISTENTE_XYZ',
            modelo: 'SUPER_CAR_999',
            anio: 2022,
            codp: '7600'
        });

        if (
            resFallback.ok &&
            resFallback.fallback_humano === true &&
            resFallback.mensaje_cliente &&
            resFallback.motivo
        ) {
            console.log(`✅ TEST 5 PASSED -> Fallback a humano seguro: "${resFallback.mensaje_cliente.slice(0, 45)}..." (Motivo: ${resFallback.motivo}).`);
            passed++;
        } else {
            console.error('❌ TEST 5 FAILED -> Fallback no activado correctamente:', resFallback);
        }
    } catch (e) {
        console.error('❌ TEST 5 ERROR:', e.message);
    }

    console.log('\n====================================================');
    console.log(`🏆 RESULTADOS: ${passed}/${total} TESTS PASSED`);
    console.log('====================================================\n');

    if (passed < total) process.exit(1);
}

if (require.main === module) {
    runCotizadorTests();
}

module.exports = { runCotizadorTests };
