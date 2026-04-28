// bot.js - Orquestador Principal del Bot
import { botStatus } from './config.js';
import { SniperEngine } from './engines/SniperEngine.js';
import { QuantumEqualizerEngine } from './engines/QuantumEqualizerEngine.js';
import { ChronosHarvesterEngine } from './engines/ChronosHarvesterEngine.js';
import { KineticPressureEngine } from './engines/KineticPressureEngine.js';
import { checkAndCopyWhaleTrades } from './strategies/CopyTradingStrategy.js';
import { updateRealBalances } from './services/balanceService.js';
import { runWhaleRadar } from './services/whaleService.js';
import { monitorPortfolio, checkDailyLossLimit } from './utils/helpers.js';
import { monitorSystemHealth } from './utils/system.js'; // lo crearemos después
import { refreshWatchlist } from './utils/watchlist.js'; // lo crearemos después

// Instancias de Engines
const sniperEngine = new SniperEngine();
const equalizerEngine = new QuantumEqualizerEngine();
const chronosEngine = new ChronosHarvesterEngine();
const kineticEngine = new KineticPressureEngine();

export async function startBotLoops() {
    console.log("🚀 Iniciando todos los loops del bot...");

    // 1. Refresh Watchlist (cada 4 minutos)
    setInterval(async () => {
        await refreshWatchlist();
    }, 4 * 60 * 1000);

    // 2. Sniper IA Principal (cada 45 segundos)
    setInterval(async () => {
        await sniperEngine.scan();
    }, 45000);

    // 3. Copy Trading (cada 30 segundos)
    setInterval(async () => {
        await checkAndCopyWhaleTrades();
    }, 30000);

    // 4. Quantum Equalizer (cada 2 minutos)
    setInterval(async () => {
        await equalizerEngine.scan();
    }, 2 * 60 * 1000);

    // 5. Chronos Harvester (cada 15 minutos)
    setInterval(async () => {
        await chronosEngine.scan();
    }, 15 * 60 * 1000);

    // Primera ejecución manual de Chronos
    setTimeout(async () => {
        console.log("⏳ [CHRONOS] Primera ejecución manual...");
        await chronosEngine.scan();
    }, 10000);

    // 6. Kinetic Pressure (cada 20 segundos)
    setInterval(async () => {
        await kineticEngine.scan();
    }, 20000);

    // 7. Monitoreo de Portfolio (cada 3 minutos)
    setInterval(async () => {
        await monitorPortfolio();
    }, 3 * 60 * 1000);

    // 8. Daily Loss Limit (cada 2 minutos)
    setInterval(async () => {
        await checkDailyLossLimit();
    }, 2 * 60 * 1000);

    // 9. Whale Radar (cada 1 hora)
    setInterval(async () => {
        await runWhaleRadar();
    }, 60 * 60 * 1000);

    // Primera ejecución del radar
    setTimeout(async () => await runWhaleRadar(), 15000);

    // 10. System Health (cada 90 segundos)
    setInterval(async () => {
        await monitorSystemHealth();
    }, 90000);

    // 11. Balances (cada 60 segundos)
    setInterval(async () => {
        await updateRealBalances();
    }, 60000);

    // Primera ejecución general
    await refreshWatchlist();
    await updateRealBalances();
    await sniperEngine.scan();

    console.log("✅ Todos los motores del bot están activos.");
}

// Exportar engines para control manual desde routes si es necesario
export {
    sniperEngine,
    equalizerEngine,
    chronosEngine,
    kineticEngine
};