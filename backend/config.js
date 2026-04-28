// ==========================================
// config.js - Estado Global + Persistencia
// ==========================================

import fs from 'fs';
import path from 'path';
import { CONFIG_FILE, DEFAULT_SETTINGS } from './constants.js';

export let botStatus = {
    lastCheck: null,
    lastProbability: 0,
    currentMarket: { title: "Iniciando escáner...", title_es: "Iniciando escáner..." },
    currentTopic: "Inicializando radares...",
    watchlist: [],
    macroWatchlist: [],
    lastNews: [],
    balanceUSDC: "0.00",
    walletOnlyUSDC: "0.00",
    clobOnlyUSDC: "0.00",
    unclaimedUSDC: "0.00",
    balancePOL: "0.00",
    carteraTotal: "0.00",
    activePositions: [],
    executions: [],
    pendingSignals: [],

    // Configuraciones principales
    aiConfig: {
        standard: { predictionThreshold: 0.70, edgeThreshold: 0.08, takeProfitThreshold: 40, stopLossThreshold: -40, microBetAmount: 5 },
        volatile: { predictionThreshold: 0.85, edgeThreshold: 0.12, takeProfitThreshold: 25, stopLossThreshold: -30, microBetAmount: 0.5 }
    },
    whaleConfig: {
        standard: { takeProfitThreshold: 90, stopLossThreshold: -90, maxCopyPercentOfBalance: 8, maxCopySize: 50 },
        volatile: { takeProfitThreshold: 50, stopLossThreshold: -50, maxCopyPercentOfBalance: 2, maxCopySize: 10 }
    },

    autoTradeEnabled: true,
    copyTradingCustomEnabled: false,
    copyTradingAutoEnabled: true,
    isPanicStopped: false,

    marketFilters: {
        crypto: true,
        politics: true,
        business: true,
        sports: false,
        pop: false,
    },

    customWhales: [],
    customMarketRules: [],
    positionEngines: {},

    // Copy Trading
    maxCopyMarketsPerWhale: 1,
    copyMinWhaleSize: 150,
    copyTimeWindowMinutes: 45,
    autoWhaleCount: 15,
    maxCopyMarketsCustom: 10,
    maxCopyDaysForWhales: 15,

    // Engines
    equalizerEnabled: false,
    equalizerShockThreshold: 15,
    equalizerBetAmount: 5,
    equalizerTpThreshold: 15,

    chronosEnabled: false,
    chronosBetAmount: 5,
    chronosMinPrice: 0.55,
    chronosMaxPrice: 0.92,
    chronosHoursLeft: 168,
    chronosTpThreshold: 20,

    kineticEnabled: false,
    kineticBetAmount: 10,
    kineticImbalanceRatio: 8,
    kineticDepthPercent: 2,
    kineticMaxPositions: 3,
    kineticTpThreshold: 10,

    // Otros
    aiReserveAmount: 50,
    dailyLossLimit: 15,
    dailyPnL: 0,
    dailyStartBalance: 0,
    riskSettings: {
        entrySlippage: 5,
        panicSlippage: 40,
        maxGasPrice: 1.5,
        tradeCooldownMin: 60,
        tpLiquiditySlippage: 55,
    },
    whalePostPartialTp: 80,

    aiStats: { wins: 0, losses: 0, totalTrades: 0, winRate: 0.0 },
    whaleStats: { wins: 0, losses: 0, totalTrades: 0, winRate: 0.0 },

    lastTrades: {}, // Cooldown
    copiedPositions: [],
    copiedTrades: [],
    copyTradingStats: { totalCopied: 0, successful: 0 },
};

// ==========================================
// PERSISTENCIA
// ==========================================

export function saveConfigToDisk(origin = "Sistema") {
    try {
        const configToSave = {
            aiConfig: botStatus.aiConfig,
            whaleConfig: botStatus.whaleConfig,
            marketFilters: botStatus.marketFilters,
            autoTradeEnabled: botStatus.autoTradeEnabled,
            copyTradingCustomEnabled: botStatus.copyTradingCustomEnabled,
            copyTradingAutoEnabled: botStatus.copyTradingAutoEnabled,
            maxWhalesToCopy: botStatus.maxWhalesToCopy,
            maxActiveSportsMarkets: botStatus.maxActiveSportsMarkets,
            customWhales: botStatus.customWhales,
            dailyLossLimit: botStatus.dailyLossLimit,
            copiedPositions: botStatus.copiedPositions || [],
            copiedTrades: botStatus.copiedTrades || [],
            riskSettings: botStatus.riskSettings,
            customMarketRules: botStatus.customMarketRules || [],

            maxCopyMarketsPerWhale: botStatus.maxCopyMarketsPerWhale,
            copyMinWhaleSize: botStatus.copyMinWhaleSize,
            copyTimeWindowMinutes: botStatus.copyTimeWindowMinutes,
            autoWhaleCount: botStatus.autoWhaleCount,
            maxCopyMarketsCustom: botStatus.maxCopyMarketsCustom,
            maxCopyDaysForWhales: botStatus.maxCopyDaysForWhales,

            aiStats: botStatus.aiStats,
            whaleStats: botStatus.whaleStats,

            equalizerEnabled: botStatus.equalizerEnabled,
            equalizerShockThreshold: botStatus.equalizerShockThreshold,
            equalizerBetAmount: botStatus.equalizerBetAmount,
            equalizerTpThreshold: botStatus.equalizerTpThreshold,

            chronosEnabled: botStatus.chronosEnabled,
            chronosBetAmount: botStatus.chronosBetAmount,
            chronosMinPrice: botStatus.chronosMinPrice,
            chronosMaxPrice: botStatus.chronosMaxPrice,
            chronosHoursLeft: botStatus.chronosHoursLeft,
            chronosTpThreshold: botStatus.chronosTpThreshold,

            kineticEnabled: botStatus.kineticEnabled,
            kineticBetAmount: botStatus.kineticBetAmount,
            kineticImbalanceRatio: botStatus.kineticImbalanceRatio,
            kineticDepthPercent: botStatus.kineticDepthPercent,
            kineticMaxPositions: botStatus.kineticMaxPositions,
            kineticTpThreshold: botStatus.kineticTpThreshold,

            whalePostPartialTp: botStatus.whalePostPartialTp,
            positionEngines: botStatus.positionEngines || {},
        };

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2), 'utf8');
        console.log(`💾 Configuración guardada en el disco. (Origen: ${origin})`);
    } catch (err) {
        console.error("❌ Error guardando configuración:", err.message);
    }
}

export function loadConfigFromDisk() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            const savedConfig = JSON.parse(data);

            // Mezclamos con defaults
            Object.assign(botStatus, savedConfig);

            console.log("📂 Configuración y Memoria cargada con éxito.");
            console.log(`📋 Límite por ballena cargado: ${botStatus.maxCopyMarketsPerWhale} mercados`);
        } else {
            console.log("📝 No hay archivo de configuración. Se creará uno nuevo.");
            saveConfigToDisk("Inicialización");
        }
    } catch (err) {
        console.error("❌ Error cargando configuración previa:", err.message);
    }
}

// Inicializar al importar
loadConfigFromDisk();

export default botStatus;