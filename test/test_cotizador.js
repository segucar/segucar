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
    let total = 4;

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

    // ── TEST 2: Cotización en Vivo (NRE Live + InfoAuto) ─────────────────────
    try {
        console.log('🔄 Ejecutando cotización en vivo para Gol Trend 2018 (CP 7600)...');
        // Limpiar caché previo de prueba si existe
        db.prepare("DELETE FROM cotizaciones_cache WHERE cache_key LIKE 'VOLKSWAGEN_GOL%'").run();

        const resLive = await cotizarVehiculo({
            marca: 'VOLKSWAGEN',
            modelo: 'GOL TREND',
            anio: 2018,
            codp: '7600'
        });

        if (
            resLive.ok &&
            !resLive.fallback_humano &&
            resLive.planes &&
            resLive.planes.length >= 4 &&
            resLive.vehiculo &&
            resLive.vehiculo.suma_asegurada > 0 &&
            resLive.origen === 'nre_live'
        ) {
            console.log(`✅ TEST 2 PASSED -> Cotización en vivo exitosa: Suma ${resLive.vehiculo.suma_asegurada_formato}, ${resLive.planes.length} planes devueltos (RC: ${resLive.planes[0].cuota_formato}).`);
            passed++;
        } else {
            console.error('❌ TEST 2 FAILED -> Respuesta inesperada en vivo:', resLive);
        }
    } catch (e) {
        console.error('❌ TEST 2 ERROR:', e.message);
    }

    // ── TEST 3: Verificación de Caché Local 24hs (Segunda llamada) ───────────
    try {
        const tStart = Date.now();
        const resCache = await cotizarVehiculo({
            marca: 'VOLKSWAGEN',
            modelo: 'GOL TREND',
            anio: 2018,
            codp: '7600'
        });
        const elapsed = Date.now() - tStart;

        if (
            resCache.ok &&
            resCache.origen === 'cache_local' &&
            resCache.cached_at &&
            elapsed < 50
        ) {
            console.log(`✅ TEST 3 PASSED -> Caché local 24hs validada en ${elapsed}ms (Origen: cache_local).`);
            passed++;
        } else {
            console.error('❌ TEST 3 FAILED -> No respondió desde caché local:', { resCache, elapsed });
        }
    } catch (e) {
        console.error('❌ TEST 3 ERROR:', e.message);
    }

    // ── TEST 4: Fallback Elegante a Humano ───────────────────────────────────
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
            console.log(`✅ TEST 4 PASSED -> Fallback a humano seguro: "${resFallback.mensaje_cliente.slice(0, 45)}..." (Motivo: ${resFallback.motivo}).`);
            passed++;
        } else {
            console.error('❌ TEST 4 FAILED -> Fallback no activado correctamente:', resFallback);
        }
    } catch (e) {
        console.error('❌ TEST 4 ERROR:', e.message);
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
