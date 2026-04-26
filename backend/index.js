// 1. 🛠️ FIX CRÍTICO: Inyectar Web Crypto API (Para Docker/Node)
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import Anthropic from '@anthropic-ai/sdk';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import Parser from 'rss-parser';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import https from 'https';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import cron from 'node-cron';

const agent = new https.Agent({  
    rejectUnauthorized: false 
});

dotenv.config();

// Inicializar Grok (xAI)
const grokClient = new OpenAI({
    apiKey: process.env.GROK_API_KEY,
    baseURL: "https://api.x.ai/v1",
});

// 👇 INICIALIZAR GEMINI (Global)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

// Usamos 'let' porque inyectaremos el modelo dinámicamente al arrancar el servidor
let geminiModel = null;

// --- CONFIGURACIÓN DE IA Y DASHBOARD ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🛡️ SISTEMA DE LOGS EN MEMORIA (Para el Dashboard)
// ==========================================
const memoryLogs = [];
const MAX_LOGS = 100; // Mantenemos la memoria RAM ligera

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function interceptLog(type, args) {
    const time = new Date().toLocaleTimeString();
    // Convertimos objetos a string para que no salga [object Object]
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    
    memoryLogs.push({ time, type, message });
    if (memoryLogs.length > MAX_LOGS) memoryLogs.shift(); // Borra el más viejo
}

// Clonamos el comportamiento estándar
console.log = function(...args) {
    originalConsoleLog.apply(console, args);
    interceptLog('info', args);
};

console.error = function(...args) {
    originalConsoleError.apply(console, args);
    interceptLog('error', args);
};

// 📡 ENDPOINT PARA LA TERMINAL DEL DASHBOARD
app.get('/api/logs', (req, res) => {
    res.json(memoryLogs);
});

// ==========================================
// RECLAMAR USDC - Endpoint con toggle Gasless / Directo
// ==========================================
app.get('/redeem', async (req, res) => {
    try {
        const useGasless = req.query.gasless === 'true' || botStatus.preferGaslessRedeem === true;

        let mensaje = `🔄 **RECLAMANDO USDC**\n`;
        mensaje += `Modo: ${useGasless ? '🟢 GASLESS (Relayer)' : '🔴 DIRECTO (paga gas)'}\n\n`;

        // 1. Cancelar órdenes abiertas
        console.log("🧹 Cancelando órdenes abiertas...");
        await clobClient.cancelAll().catch(() => {});
        mensaje += "✅ Órdenes abiertas canceladas.\n\n";

        // 2. Ejecutar Redeem según el modo elegido
        let redeemed = 0;
        if (useGasless) {
            redeemed = await autoRedeemPositionsGasless();
            mensaje += `✅ Gasless Redeem ejecutado (${redeemed} posiciones canjeadas).\n`;
        } else {
            redeemed = await autoRedeemPositions(); // versión directa
            mensaje += `✅ Redeem directo ejecutado (${redeemed} posiciones canjeadas).\n`;
        }

        // 3. Actualizar balances
        await updateRealBalances();

        const polyBalance = parseFloat(botStatus.clobOnlyUSDC || 0);
        const metaBalance = parseFloat(botStatus.walletOnlyUSDC || 0);
        const total = (polyBalance + metaBalance).toFixed(2);

        mensaje += `\n💰 **Saldo actual:** $${total} USDC\n`;
        mensaje += `   • Polymarket: $${polyBalance.toFixed(2)}\n`;
        mensaje += `   • MetaMask: $${metaBalance.toFixed(2)}`;

        console.log(`✅ Reclamo completado (${useGasless ? 'gasless' : 'directo'})`);
        res.send(mensaje);

    } catch (error) {
        console.error("❌ Error en /redeem:", error.message);
        res.send(`❌ Error durante el reclamo:\n${error.message}`);
    }
});

// 🛡️ BARRERA DE SEGURIDAD: Autenticación Premium
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Sniper2026';

app.use('/api', (req, res, next) => {
    if (req.method === 'OPTIONS') return next(); // Dejar pasar pre-vuelo de CORS
    
    const providedPassword = req.headers['authorization'];
    
    if (providedPassword === DASHBOARD_PASSWORD) {
        next(); // Clave correcta, permitir paso a la API
    } else {
        res.status(401).json({ error: 'Acceso Denegado: Bóveda cerrada' });
    }
});

const PORT = process.env.PORT || 3001;
// Memoria de corto plazo para ahorrar créditos
const analysisCache = new Map();
const redeemedCache = new Set();
const profitAlertCache = new Set(); // Memoria para no repetir alertas de toma de ganancias (Spam)
// 🛡️ NUEVA MEMORIA: Lista negra de mercados ya operados y cerrados hoy
const closedPositionsCache = new Set();
const pendingOrdersCache = new Set();

// ==========================================
// 📡 CACHÉ DEL RADAR DE BALLENAS
// ==========================================
let whaleRadarCache = {
    lastScan: null,
    isScanning: false,
    whales: []
};

// --- ESTADO GLOBAL DEL SNIPER ---
let botStatus = {
    lastCheck: null,
    lastProbability: 0,
    currentMarket: { title: "Iniciando escáner...", title_es: "Iniciando escáner..." }, 
    currentTopic: "Inicializando radares...",
    watchlist: [],
    lastNews: [], 
    balanceUSDC: "0.00",      
    walletOnlyUSDC: "0.00",   
    clobOnlyUSDC: "0.00",     
    unclaimedUSDC: "0.00",
    balancePOL: "0.00",
    activePositions: [],
    executions: [], 
    pendingSignals: [], 

    // 🔥 NUEVA ARQUITECTURA BIFURCADA BIDIMENSIONAL
    aiConfig: {
        standard: { predictionThreshold: 0.70, edgeThreshold: 0.08, takeProfitThreshold: 40, stopLossThreshold: -40, microBetAmount: 5 },
        volatile: { predictionThreshold: 0.85, edgeThreshold: 0.12, takeProfitThreshold: 25, stopLossThreshold: -30, microBetAmount: 0.5 }
    },
    whaleConfig: {
        standard: { takeProfitThreshold: 90, stopLossThreshold: -90, maxCopyPercentOfBalance: 8, maxCopySize: 50 },
        volatile: { takeProfitThreshold: 50, stopLossThreshold: -50, maxCopyPercentOfBalance: 2, maxCopySize: 10 }
    },

    autoTradeEnabled: true,
    copyTradingCustomEnabled: false,     // ← Card Custom (la que usas)
    copyTradingAutoEnabled: true,        // ← Card Auto (leaderboard)
    isPanicStopped: false,
    suggestedInversion: 0, 
    potentialROI: 0,
    maxActiveSportsMarkets: 2,
    dailyLossLimit: 15,                   
    dailyPnL: 0,                          
    dailyStartBalance: 0,                 
    autoRedeemEnabled: true,              
    autoSelectedWhales: [],        
    maxWhalesToCopy: 5,            
    lastWhaleSelection: null,
    copiedTrades: [],
    copiedPositions: [],
    copyTradingStats: { totalCopied: 0, successful: 0 },
    marketFilters: {
        crypto: true,
        politics: true,
        business: true,
        sports: false,
        pop: false,
    },
    customWhales: [],
    riskSettings: {
        entrySlippage: 5,       // % máximo para comprar o Take Profit
        panicSlippage: 40,      // % máximo para Stop Loss (Emergencia)
        maxGasPrice: 1.5,       // POL máximo por transacción
        tradeCooldownMin: 60    // Minutos para no repetir un mercado
    },
    customMarketRules: [],
    // 🔥 NUEVO: Límite de mercados por ballena (Copy Trading Custom)
    maxCopyMarketsPerWhale: 1,     // 1 = por defecto (1 mercado por ballena)
    copyMinWhaleSize: 150,           // ← Tamaño de Trade Minimo
    copyTimeWindowMinutes: 45,       // ← Ventana de tiempo para volver a checar los trades
    lastTrades: {}, // Objeto para controlar el Cooldown: { tokenId: timestamp }
    aiStats: { wins: 0, losses: 0, totalTrades: 0, winRate: 0.0 },
    whaleStats: { wins: 0, losses: 0, totalTrades: 0, winRate: 0.0 },
    aiReserveAmount: 50,
    positionEngines: {}, // <-- NUEVO: Guardará los tatuajes de las posiciones
    kineticMaxPositions: 3
};

// ==========================================
// 🌊 QUANTUM EQUALIZER (Memoria RAM y Estado)
// ==========================================
// Este caché guardará el historial de precios en RAM, no en disco, para ser ultra rápido.
const priceHistoryCache = {}; // Estructura: { tokenId: [{ timestamp, price }, ...] }

// Inicialización de seguridad para las nuevas variables de estado
if (botStatus.equalizerEnabled === undefined) botStatus.equalizerEnabled = false;
if (botStatus.equalizerShockThreshold === undefined) botStatus.equalizerShockThreshold = 15; // 15% de salto por defecto
if (botStatus.equalizerBetAmount === undefined) botStatus.equalizerBetAmount = 5; // $5 USDC de disparo

// ==========================================
// ⏳ CHRONOS HARVESTER (Estado)
// ==========================================
if (botStatus.chronosEnabled === undefined) botStatus.chronosEnabled = false;
if (botStatus.chronosBetAmount === undefined) botStatus.chronosBetAmount = 5;
if (botStatus.chronosMinPrice === undefined) botStatus.chronosMinPrice = 0.75;
if (botStatus.chronosMaxPrice === undefined) botStatus.chronosMaxPrice = 0.88;
if (botStatus.chronosHoursLeft === undefined) botStatus.chronosHoursLeft = 168;

// ==========================================
// 🌊 KINETIC PRESSURE (Estado y Configuración)
// ==========================================
if (botStatus.kineticEnabled === undefined) botStatus.kineticEnabled = false;
if (botStatus.kineticBetAmount === undefined) botStatus.kineticBetAmount = 10; // Disparo por defecto
if (botStatus.kineticImbalanceRatio === undefined) botStatus.kineticImbalanceRatio = 8; // 8 a 1 es un muro sólido
if (botStatus.kineticDepthPercent === undefined) botStatus.kineticDepthPercent = 2; // Rango de precio a analizar (2%)


// ==========================================
// 🧠 MOTOR DE MEMORIA PERSISTENTE (V3 LIMPIA)
// ==========================================
const CONFIG_FILE = path.join(process.cwd(), 'bot_config.json');

// Función para GUARDAR la configuración
function saveConfigToDisk(origen = "Sistema") {
    try {
        const configToSave = {
            aiConfig: botStatus.aiConfig,
            whaleConfig: botStatus.whaleConfig,
            marketFilters: botStatus.marketFilters,
            autoTradeEnabled: botStatus.autoTradeEnabled,
            copyTradingCustomEnabled: botStatus.copyTradingCustomEnabled,   // ← nuevo
            copyTradingAutoEnabled: botStatus.copyTradingAutoEnabled,       // ← nuevo
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
            // 🔥 FIX QUANT: Guardamos los Winrates en el disco duro
            aiStats: botStatus.aiStats,
            whaleStats: botStatus.whaleStats,
            // 🌊 FIX QUANT: Guardado de estado del Quantum Equalizer
            equalizerEnabled: botStatus.equalizerEnabled,
            equalizerShockThreshold: botStatus.equalizerShockThreshold,
            equalizerBetAmount: botStatus.equalizerBetAmount,
            // ⏳ CHRONOS HARVESTER
            chronosEnabled: botStatus.chronosEnabled,
            chronosBetAmount: botStatus.chronosBetAmount,
            chronosMinPrice: botStatus.chronosMinPrice,
            chronosMaxPrice: botStatus.chronosMaxPrice,
            // 🏷️ MEMORIA DE ETIQUETAS
            positionEngines: botStatus.positionEngines,
            // 🌊 KINETIC PRESSURE
            kineticEnabled: botStatus.kineticEnabled,
            kineticBetAmount: botStatus.kineticBetAmount,
            kineticImbalanceRatio: botStatus.kineticImbalanceRatio,
            kineticDepthPercent: botStatus.kineticDepthPercent,
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2), 'utf8');
        console.log(`💾 Configuración guardada en el disco. (Origen: ${origen})`);
    } catch (err) {
        console.error("❌ Error guardando configuración:", err.message);
    }
}

// Función para CARGAR la configuración
function loadConfigFromDisk() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            const savedConfig = JSON.parse(data);

            if (savedConfig.aiConfig) botStatus.aiConfig = savedConfig.aiConfig;
            if (savedConfig.whaleConfig) botStatus.whaleConfig = savedConfig.whaleConfig;
            if (savedConfig.marketFilters) botStatus.marketFilters = savedConfig.marketFilters;
            if (savedConfig.autoTradeEnabled !== undefined) botStatus.autoTradeEnabled = savedConfig.autoTradeEnabled;
            if (savedConfig.copyTradingCustomEnabled !== undefined) botStatus.copyTradingCustomEnabled = savedConfig.copyTradingCustomEnabled;
            if (savedConfig.copyTradingAutoEnabled !== undefined) botStatus.copyTradingAutoEnabled = savedConfig.copyTradingAutoEnabled;
            if (savedConfig.maxWhalesToCopy !== undefined) botStatus.maxWhalesToCopy = savedConfig.maxWhalesToCopy;
            if (savedConfig.maxActiveSportsMarkets !== undefined) botStatus.maxActiveSportsMarkets = savedConfig.maxActiveSportsMarkets;
            if (savedConfig.customWhales !== undefined) botStatus.customWhales = savedConfig.customWhales;
            if (savedConfig.dailyLossLimit !== undefined) botStatus.dailyLossLimit = savedConfig.dailyLossLimit;
            if (savedConfig.copiedPositions) botStatus.copiedPositions = savedConfig.copiedPositions;
            if (savedConfig.copiedTrades) botStatus.copiedTrades = savedConfig.copiedTrades;
            
            // 🔥 NUEVO: Recuperar configuración de Riesgo
            if (savedConfig.riskSettings) {
                botStatus.riskSettings = { ...botStatus.riskSettings, ...savedConfig.riskSettings };
            }

            // 🔥 NUEVO: Reglas personalizadas por mercado (Parche #8)
            if (savedConfig.customMarketRules) {
                botStatus.customMarketRules = savedConfig.customMarketRules;
                console.log(`📋 Cargadas ${savedConfig.customMarketRules.length} reglas personalizadas de mercado`);
            } else {
                botStatus.customMarketRules = []; // Inicializamos vacío si no existe
            }

            // 🔥 NUEVO: Límite de mercados por ballena (Parche #9)
            if (savedConfig.maxCopyMarketsPerWhale !== undefined) {
                botStatus.maxCopyMarketsPerWhale = savedConfig.maxCopyMarketsPerWhale;
                console.log(`📋 Límite por ballena cargado: ${savedConfig.maxCopyMarketsPerWhale} mercados`);
            }

            if (savedConfig.maxCopyMarketsPerWhale !== undefined) {
                botStatus.maxCopyMarketsPerWhale = savedConfig.maxCopyMarketsPerWhale;
            }

            if (savedConfig.copyMinWhaleSize !== undefined) botStatus.copyMinWhaleSize = savedConfig.copyMinWhaleSize;
            if (savedConfig.copyTimeWindowMinutes !== undefined) botStatus.copyTimeWindowMinutes = savedConfig.copyTimeWindowMinutes;

            // 🔥 FIX QUANT: Cargar los Winrates desde el disco al iniciar
            if (savedConfig.aiStats) botStatus.aiStats = savedConfig.aiStats;
            if (savedConfig.whaleStats) botStatus.whaleStats = savedConfig.whaleStats;

            // 🌊 FIX QUANT: Cargar configuración del Quantum Equalizer
            if (savedConfig.equalizerEnabled !== undefined) botStatus.equalizerEnabled = savedConfig.equalizerEnabled;
            if (savedConfig.equalizerShockThreshold !== undefined) botStatus.equalizerShockThreshold = savedConfig.equalizerShockThreshold;
            if (savedConfig.equalizerBetAmount !== undefined) botStatus.equalizerBetAmount = savedConfig.equalizerBetAmount;

            // ⏳ CHRONOS HARVESTER
            if (savedConfig.chronosEnabled !== undefined) botStatus.chronosEnabled = savedConfig.chronosEnabled;
            if (savedConfig.chronosBetAmount !== undefined) botStatus.chronosBetAmount = savedConfig.chronosBetAmount;
            if (savedConfig.chronosMinPrice !== undefined) botStatus.chronosMinPrice = savedConfig.chronosMinPrice;
            if (savedConfig.chronosMaxPrice !== undefined) botStatus.chronosMaxPrice = savedConfig.chronosMaxPrice;

            // 🏷️ MEMORIA DE ETIQUETAS
            if (savedConfig.positionEngines) botStatus.positionEngines = savedConfig.positionEngines;

            // 🌊 KINETIC PRESSURE
            if (savedConfig.kineticEnabled !== undefined) botStatus.kineticEnabled = savedConfig.kineticEnabled;
            if (savedConfig.kineticBetAmount !== undefined) botStatus.kineticBetAmount = savedConfig.kineticBetAmount;
            if (savedConfig.kineticImbalanceRatio !== undefined) botStatus.kineticImbalanceRatio = savedConfig.kineticImbalanceRatio;
            if (savedConfig.kineticDepthPercent !== undefined) botStatus.kineticDepthPercent = savedConfig.kineticDepthPercent;

            console.log("📂 Configuración y Memoria cargada con éxito.");
        } else {
            console.log("📝 No hay archivo de configuración. Se creará uno nuevo.");
            saveConfigToDisk("Inicialización"); 
        }
    } catch (err) {
        console.error("❌ Error cargando configuración previa:", err.message);
    }
}

loadConfigFromDisk();

// --- INICIALIZACIONES EXTERNAS ---
const telegram = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
const parser = new Parser();

// --- CONFIGURACIÓN BLOCKCHAIN ---
const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY, provider);
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const CTF_EXCHANGE_ADDRESS = "0x4BFb304598296E5105583dA39cE9dcFD29944545"; 

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

console.log("✅ MODO SNIPER PRODUCCIÓN ACTIVADO");
console.log("Wallet conectada:", wallet.address);

// ==========================================
// 1. CONEXIÓN CLOB (VERSIÓN CORRECTA 2026)
// ==========================================
let clobClient;

async function conectarClob() {
    try {
        console.log("🔐 Autenticando con Polymarket...");

        // 🚨 EL FIX PRINCIPAL: Tu funder exitoso
        const PROXY_WALLET = "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2"; 

        // Cliente temporal para derivar API credentials
        const authClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
        const apiCreds = await authClient.createOrDeriveApiKey();

        console.log("✅ API Credentials obtenidas");

        // Cliente FINAL
        clobClient = new ClobClient(
            "https://clob.polymarket.com",
            137,
            wallet,           
            apiCreds,
            2,                // Signature Type 2
            PROXY_WALLET      // El funder correcto
        );

        await new Promise(resolve => setTimeout(resolve, 1500)); 

        console.log("✅ CLOB Client conectado correctamente");
        console.log(`   - Funder (Proxy): ${PROXY_WALLET}`);
        console.log(`   - Signature Type: 2`);

        return clobClient;

    } catch (error) {
        console.error("❌ Error conectando CLOB:", error.message);
        throw error;
    }
}
conectarClob();

// ==========================================
// 2. ACTUALIZACIÓN DE SALDOS (NATIVA CLOB) - VERSIÓN BLINDADA QUANT
// ==========================================
async function updateRealBalances() {
    try {
        // 1. Balance de Gas (POL)
        const polBal = await provider.getBalance(wallet.address);
        botStatus.balancePOL = Number(ethers.utils.formatEther(polBal)).toFixed(3);

        // 2. Balance USDC en MetaMask
        const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
        const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);
        const walletBalRaw = await usdcContract.balanceOf(wallet.address);
        botStatus.walletOnlyUSDC = (parseFloat(ethers.utils.formatUnits(walletBalRaw, 6))).toFixed(2);

        // 3. Balance USDC en Polymarket (CLOB)
        if (clobClient) {
            await clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" });
            const balanceData = await clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" });
            const clobMonto = parseFloat(balanceData.balance || 0) / 1000000;
            botStatus.clobOnlyUSDC = clobMonto.toFixed(2);
            botStatus.balanceUSDC = botStatus.clobOnlyUSDC;
        }

        // 4. Posiciones activas + CANJEAR (FIX FINAL)
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
            
            // 🔥 FIX CRÍTICO 1: Límite a 500 para evitar posiciones invisibles
            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=500`);
            const positions = await response.json();
            
            botStatus.activePositions = []; 
            let totalUnclaimed = 0;

            if (Array.isArray(positions) && positions.length > 0) {
                for (const pos of positions) {
                    const size = parseFloat(pos.size || 0);
                    if (size < 0.1) continue; // Ignoramos polvo (dust)

                    const cashPnl = parseFloat(pos.cashPnl || 0);
                    const percentPnl = parseFloat(pos.percentPnl || 0);
                    const valorActual = parseFloat(pos.currentValue || pos.value || 0);

                    const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                    // 🔥 CLAVE: Si está lista para canjear, NO la mostramos en activePositions
                    if (isRedeemable) {
                        totalUnclaimed += valorActual;
                        continue;   // ← Ocultamos del dashboard
                    }

                    // Solo agregamos posiciones realmente activas
                    let outcomeVal = "N/A";
                    if (pos.outcome) {
                        outcomeVal = String(pos.outcome).toUpperCase();
                    } else if (pos.assetName && typeof pos.assetName === 'string') {
                        if (pos.assetName.toUpperCase().includes("-YES")) outcomeVal = "YES";
                        else if (pos.assetName.toUpperCase().includes("-NO")) outcomeVal = "NO";
                    }

                    const currentTokenId = pos.asset || pos.token_id || pos.asset_id;

                    // 🔥 FIX CRÍTICO 2: Extracción Directa desde la API para precisión matemática total
                    const invested = pos.initialValue ? parseFloat(pos.initialValue) : Math.max(0, valorActual - cashPnl);
                    const entryPrice = pos.avgPrice ? parseFloat(pos.avgPrice) : (size > 0 ? (invested / size) : 0);

                    // Recuperar Nickname de Ballena si existe
                    const whaleData = botStatus.copiedPositions?.find(p => p.tokenId === currentTokenId);

                    botStatus.activePositions.push({
                        tokenId: currentTokenId,
                        conditionId: pos.conditionId || pos.condition_id,
                        size: size.toFixed(2),
                        exactSize: size,
                        marketName: pos.title || pos.market || "Mercado Desconocido",
                        status: "ACTIVO 🟢",
                        currentValue: valorActual.toFixed(2),
                        cashPnl: cashPnl,
                        percentPnl: percentPnl,
                        category: getMarketCategoryEnhanced(pos.title || pos.market || ""),
                        outcome: outcomeVal,
                        engine: botStatus.positionEngines[currentTokenId] || null, 
                        sizeCopied: invested, // <-- RESTAURA VISUALMENTE LA INVERSIÓN (Con precisión absoluta)
                        priceEntry: entryPrice, // <-- RESTAURA VISUALMENTE EL PRECIO (Con precisión absoluta)
                        nickname: whaleData ? whaleData.nickname : null 
                    });
                }
            }
            
            botStatus.unclaimedUSDC = totalUnclaimed.toFixed(2);

            // LIMPIEZA AUTOMÁTICA de copiedTrades
            await cleanupCopiedTrades();

        } catch (apiError) {
            console.log("⚠️ Error al obtener posiciones:", apiError.message);
        }

        // Log de balances
        if (Math.random() < 0.25) {
            const metaMaskVal = parseFloat(botStatus.walletOnlyUSDC || 0);
            const polyVal = parseFloat(botStatus.clobOnlyUSDC || 0);
            const unclaimedVal = parseFloat(botStatus.unclaimedUSDC || 0);
            const activePosValue = botStatus.activePositions.reduce((acc, p) => acc + parseFloat(p.currentValue || 0), 0);
            const carteraTotalReal = (metaMaskVal + polyVal + activePosValue + unclaimedVal).toFixed(2);

            console.log(`📊 Balances: Cartera Total: $${carteraTotalReal} | Disponible (Poly): $${polyVal.toFixed(2)} | MetaMask: $${metaMaskVal.toFixed(2)} | Gas: ${botStatus.balancePOL} POL`);
        }

    } catch (e) { 
        console.error("❌ Error general actualizando balances:", e.message); 
    }
}

// ==========================================
// 🌊 KINETIC PRESSURE ENGINE (Orderbook Imbalance)
// ==========================================
async function runKineticPressureScanner() {
    if (!botStatus.kineticEnabled || botStatus.isPanicStopped) return;

    // 🔥 USAR EL LÍMITE DINÁMICO DEL DASHBOARD
    const kineticActiveCount = botStatus.activePositions.filter(p => p.engine === 'KINETIC').length;
    if (kineticActiveCount >= botStatus.kineticMaxPositions) {
        return; 
    }

    // 🛡️ REGLA QUANT: Solo escaneamos los 5 mercados con más volumen para evitar Rate Limits
    const topMarkets = [...botStatus.watchlist]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 5);

    for (const market of topMarkets) {
        try {
            // 1. Obtener Orderbook Nivel 2
            const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${market.tokenYes}`, { httpsAgent: agent, timeout: 5000 });
            const bids = bookResp.data?.bids || [];
            const asks = bookResp.data?.asks || [];

            if (bids.length === 0 || asks.length === 0) continue;

            const midPrice = (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2;
            const range = botStatus.kineticDepthPercent / 100;

            // 2. Sumar liquidez en el rango de profundidad (Cazando ballenas reales)
            const buyPressure = bids
                .filter(b => parseFloat(b.price) >= midPrice * (1 - range))
                .reduce((sum, b) => sum + (parseFloat(b.size) * parseFloat(b.price)), 0);

            const sellPressure = asks
                .filter(a => parseFloat(a.price) <= midPrice * (1 + range))
                .reduce((sum, a) => sum + (parseFloat(a.size) * parseFloat(a.price)), 0);

            // 3. Calcular Ratio
            const currentRatio = buyPressure / (sellPressure || 1);

            if (currentRatio >= botStatus.kineticImbalanceRatio) {
                // 🛡️ CANDADO QUANT ESTRICTO: Previene disparos en ráfaga (Ametralladora)
                if (botStatus.activePositions.some(p => p.tokenId === market.tokenYes)) continue;
                if (pendingOrdersCache.has(market.tokenYes)) continue; // <-- FIX VITAL
                if (parseFloat(botStatus.clobOnlyUSDC || 0) < botStatus.kineticBetAmount) continue;

                console.log(`🌊 [KINETIC DETECTADO] Presión de compra extrema en ${market.title}`);
                console.log(`📊 Bids: $${buyPressure.toFixed(0)} | Asks: $${sellPressure.toFixed(0)} | Ratio: ${currentRatio.toFixed(1)}:1`);

                // 🔫 DISPARO FRONTAL
                const targetPrice = parseFloat(asks[0].price);
                const tradeResult = await executeTradeOnChain(market.conditionId, market.tokenYes, botStatus.kineticBetAmount, targetPrice, market.tickSize);

                if (tradeResult?.success) {
                    const targetTokenId = market.tokenYes;
                    
                    // 🔥 FIX VITAL: Bloquear futuros disparos instantáneamente
                    pendingOrdersCache.add(targetTokenId);
                    setTimeout(() => pendingOrdersCache.delete(targetTokenId), 60000); // Limpieza Cuántica

                    botStatus.positionEngines[targetTokenId] = "KINETIC";
                    botStatus.lastTrades[targetTokenId] = Date.now();
                    
                    // 🔥 FIX VITAL: Inyección inmediata al Frontend para verlo en vivo
                    botStatus.activePositions.push({
                        tokenId: targetTokenId,
                        conditionId: market.conditionId,
                        marketName: market.title,
                        sizeCopied: botStatus.kineticBetAmount,        
                        exactSize: botStatus.kineticBetAmount / targetPrice, 
                        priceEntry: targetPrice,
                        outcome: "YES", 
                        category: market.category || "SCALP",
                        status: "ACTIVO 🟢",
                        engine: "KINETIC" 
                    });

                    saveConfigToDisk("Disparo Kinetic Pressure");
                    
                    await sendAlert(`🌊 *KINETIC PRESSURE (BUY)*\n🎯 ${market.title}\n📊 Ratio: *${currentRatio.toFixed(1)}:1*\n💰 Inversión: $${botStatus.kineticBetAmount}\n🚀 Surfeando muro de liquidez...`);
                }
            }
        } catch (e) {
            console.error(`❌ Error en escáner Kinetic para ${market.title}:`, e.message);
        }
    }
}

// ==========================================
// 3A. MOTOR DE IA 1 (CLAUDE) - Versión Cuantitativa Anti-Alucinación
// ==========================================
async function analyzeMarketWithClaude(marketQuestion, currentNews, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 180,
                system: `Eres un Senior Quant Trader especializado en Polymarket.

TUS INSTRUCCIONES:
Analiza el mercado específico usando SOLO las noticias proporcionadas.

REGLAS ANTI-ALUCINACIÓN (ESTRICTAS):
1. AISLAMIENTO DE CONTEXTO: Tu análisis debe tratar EXCLUSIVAMENTE sobre el tema del mercado. No inventes conexiones con la inflación, la Fed, Trump o la geopolítica si el mercado no los menciona explícitamente.
2. RIGOR ESTADÍSTICO: No infles probabilidades. Si las noticias no te dan una ventaja matemática clara, tu probabilidad debe ser conservadora (ej. 0.50) y tu recomendación "WAIT".
3. CONCISIÓN: Tu "reason" debe ser lógica, directa y referirse 100% al mercado en cuestión.

Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`,
                messages: [{ role: "user", content: `Mercado a analizar: "${marketQuestion}"\nNoticias Recientes: "${currentNews}"\nAnaliza la ventaja real en las próximas 96 horas.` }]
            });

            const jsonMatch = response.content[0].text.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("JSON inválido");
            const data = JSON.parse(jsonMatch[0]);

            return { 
                isError: false, 
                prob: parseFloat(data.prob) || 0, 
                strategy: data.strategy || "WAIT", 
                urgency: data.urgency || 5, 
                reason: data.reason || "Sin ventaja", 
                edge: parseFloat(data.edge) || 0, 
                recommendation: data.recommendation || "WAIT" 
            };

        } catch (error) {
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue; 
            }
            return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error Claude", edge: 0, recommendation: "WAIT" };
        }
    }
}

// ==========================================
// 3B. MOTOR DE IA 2 (GEMINI) - Versión Anti-Alucinación y Resiliente
// ==========================================
async function analyzeMarketWithGemini(marketQuestion, currentNews, retries = 2) {
    console.log("🧠 Gemini Short-Term Analysis...");
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const prompt = `Eres un Senior Quant Trader especializado en Polymarket.

TUS INSTRUCCIONES:
Analiza ESTE mercado específico usando SOLO las noticias proporcionadas.

Mercado a analizar: "${marketQuestion}"
Noticias Recientes: "${currentNews}"

REGLAS ANTI-ALUCINACIÓN (ESTRICTAS):
1. AISLAMIENTO DE CONTEXTO: Tu análisis debe tratar EXCLUSIVAMENTE sobre el tema del mercado. No inventes conexiones con la inflación, la Fed, Trump o la geopolítica si el mercado no los menciona explícitamente.
2. RIGOR ESTADÍSTICO: No infles probabilidades. Si las noticias no te dan una ventaja matemática clara, tu probabilidad debe ser conservadora (ej. 0.50) y tu recomendación "WAIT".
3. CONCISIÓN: Tu "reason" debe ser lógica, directa y referirse 100% al mercado en cuestión.

Responde ESTRICTAMENTE con este JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`;

            const result = await geminiModel.generateContent(prompt);
            const responseText = result.response.text().trim();
            const jsonMatch = responseText.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("JSON inválido");
            const data = JSON.parse(jsonMatch[0]);

            return {
                isError: false,
                prob: parseFloat(data.prob) || 0,
                strategy: data.strategy || "WAIT",
                urgency: data.urgency || 5,
                reason: data.reason || "Sin ventaja clara",
                edge: parseFloat(data.edge) || 0,
                recommendation: data.recommendation || "WAIT"
            };

        } catch (error) {
            // Si es un error de sobrecarga (503) y nos quedan intentos, esperamos y reintentamos
            const isOverloaded = error.message.includes('503') || error.message.includes('429');
            if (isOverloaded && attempt < retries) {
                console.log(`⚠️ Gemini saturado (Intento ${attempt}/${retries}). Esperando 3s...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue;
            }
            
            console.error("❌ Error en motor Gemini:", error.message);
            return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error Gemini API", edge: 0, recommendation: "WAIT" };
        }
    }
}

// ==========================================
// 3C. MOTOR DE IA 3 (GROK) - Versión Cuantitativa Anti-Alucinación
// ==========================================
async function analyzeMarketWithGrok(marketQuestion, currentNews, retries = 2) {
    console.log("🧠 Grok Short-Term Analysis...");
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await grokClient.chat.completions.create({
                model: "grok-4-1-fast-non-reasoning",
                messages: [
                    {
                        role: "system",
                        content: `Eres un Senior Quant Trader especializado en Polymarket.

TUS INSTRUCCIONES:
Analiza el mercado específico usando SOLO las noticias proporcionadas.

REGLAS ANTI-ALUCINACIÓN (ESTRICTAS):
1. AISLAMIENTO DE CONTEXTO: Tu análisis debe tratar EXCLUSIVAMENTE sobre el tema del mercado. No inventes conexiones con la inflación, la Fed, Trump o la geopolítica si el mercado no los menciona explícitamente.
2. RIGOR ESTADÍSTICO: No infles probabilidades. Si las noticias no te dan una ventaja matemática clara, tu probabilidad debe ser conservadora (ej. 0.50) y tu recomendación "WAIT".
3. CONCISIÓN: Tu "reason" debe ser lógica, directa y referirse 100% al mercado en cuestión.

Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`
                    },
                    {
                        role: "user",
                        content: `Mercado a analizar: "${marketQuestion}"\nNoticias Recientes: "${currentNews}"\nAnaliza la ventaja real en las próximas 96 horas.`
                    }
                ],
                response_format: { type: "json_object" }
            });

            const data = JSON.parse(response.choices[0].message.content);

            return {
                isError: false,
                prob: parseFloat(data.prob) || 0,
                strategy: data.strategy || "WAIT",
                urgency: data.urgency || 5,
                reason: data.reason || "Sin ventaja clara",
                edge: parseFloat(data.edge) || 0,
                recommendation: data.recommendation || "WAIT"
            };
        } catch (error) {
            const isOverloaded = error.status === 429 || error.status >= 500;
            if (isOverloaded && attempt < retries) {
                console.log(`⚠️ Grok saturado (Intento ${attempt}/${retries}). Esperando 3s...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue;
            }
            console.error("❌ Error en motor Grok:", error.message);
            return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error Grok API", edge: 0, recommendation: "WAIT" };
        }
    }
}


// ==========================================
// 4. RECOLECCIÓN DE NOTICIAS Y DATOS
// ==========================================
async function getLatestNews(query, category) {
    try {
        let searchQuery = query;
        if (category === 'CRYPTO') searchQuery += ' "CPI" OR "Fed" OR "crypto" OR "Bitcoin" OR "SEC"';
        else if (category === 'GEOPOLITICS') searchQuery += ' "military" OR "attack" OR "official" OR "news"';
        else if (category === 'SOCIAL') searchQuery += ' "twitter" OR "tweet" OR "mentions" OR "post"';

        const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`);
        
        botStatus.lastNews = feed.items.slice(0, 5).map(item => ({
            title: item.title,      
            title_es: "Análisis rápido", // Placeholder para ahorrar tokens    
            link: item.link         
        }));
        
        return botStatus.lastNews.map(n => n.title).join(". "); 
    } catch (error) { 
        return "No hay noticias recientes."; 
    }
}

// ==========================================
// 5. ALERTAS TELEGRAM
// ==========================================
async function sendAlert(message) {
    try { await telegram.sendMessage(chatId, `🤖 *PolySniper*:\n${message}`, { parse_mode: 'Markdown' }); } catch (e) {}
}

// 🟢 FUNCIÓN MEJORADA - SNIPER ALERT CON ORIGEN DEL MODELO
async function sendSniperAlert(signal) {
    const edgePct = signal.edge >= 0 ? `+${(signal.edge * 100).toFixed(1)}%` : `${(signal.edge * 100).toFixed(1)}%`;

    // 🔥 NUEVO: Mostrar el origen del modelo de forma clara y bonita
    let origen = signal.engine || "Desconocido";

    // Si es consenso, lo hacemos más legible
    if (origen.includes("Trinity") || origen.includes("Consenso")) {
        origen = `🔥 ${origen}`;
    } else if (["Claude", "Gemini", "Grok"].includes(origen)) {
        origen = `🧠 ${origen}`;
    }

    const msg = `🎯 *SNIPER AUTOMÁTICO EJECUTADO*\n\n` +
                `📋 *Mercado:* ${signal.marketName}\n` +
                `🔍 *Modelo:* ${origen}\n` +                    // ← NUEVA LÍNEA
                `🧠 *Confianza IA:* ${(signal.probability * 100).toFixed(0)}%\n` +
                `📊 *Precio de Compra:* $${signal.marketPrice}\n` +
                `📈 *Ventaja (Edge):* ${edgePct}\n` +
                `💰 *Inversión:* $${(signal.suggestedInversion).toFixed(2)} USDC\n` +
                `📝 *Razón:* ${signal.reasoning}`;

    try { 
        await telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); 
    } catch (e) { 
        console.error('❌ Error enviando alerta de Telegram:', e.message); 
    }
}

// ==========================================
// 6. UTILIDADES DE MERCADO (GAMMA API)
// ==========================================
async function getMarketPrice(tokenId) {
    if (!tokenId) return null;
    try {
        // Consultamos el precio "Midpoint" actual conectándonos directo al OrderBook L2
        const url = `https://clob.polymarket.com/midpoint?token_id=${tokenId}`;
        
        const response = await axios.get(url);
        return response.data && response.data.mid ? parseFloat(response.data.mid).toFixed(3) : null;
    } catch (e) {
        console.error("❌ Error obteniendo precio CLOB:", e.message);
        return null;
    }
}

function hoursUntilClose(endDateStr) {
    if (!endDateStr) return 999;
    return (new Date(endDateStr) - Date.now()) / (1000 * 60 * 60);
}

function getMarketCategory(title) {
    const matchAny = (words) => words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(title));
    if (matchAny(['bitcoin', 'btc', 'eth', 'crypto', 'etf', 'halving'])) return 'CRYPTO';
    if (matchAny(['israel', 'ukraine', 'russia', 'putin', 'biden', 'war', 'strikes'])) return 'GEOPOLITICS';
    if (matchAny(['elon', 'musk', 'trump', 'tweet', 'x'])) return 'SOCIAL';
    return null; 
}

// 🛡️ ESCÁNER DE CATEGORÍAS (VERSIÓN BLINDADA QUANT)
function getMarketCategoryEnhanced(title) {
    const lower = title.toLowerCase();

    // Mercados de alta frecuencia
    if (lower.includes("5m") || lower.includes("15m") || lower.includes("up or down") || 
        lower.includes("bitcoin") || lower.includes("btc") || lower.includes("eth") || 
        lower.includes("sol") || lower.includes("up/down")) {
        return "SHORT_TERM";
    }

    if (lower.includes("weather") || lower.includes("temperatura") || lower.includes("temperature")) {
        return "SHORT_TERM";
    }

    if (lower.includes("will") && (lower.includes("today") || lower.includes("tomorrow") || lower.includes("next 24h"))) {
        return "SHORT_TERM";
    }

    // Categorías originales
    if (lower.includes("bitcoin") || lower.includes("btc") || lower.includes("eth") || lower.includes("crypto")) return 'CRYPTO';
    if (lower.includes("israel") || lower.includes("ukraine") || lower.includes("russia") || lower.includes("trump") || lower.includes("biden") || lower.includes("war")) return 'GEOPOLITICS';
    if (lower.includes("elon") || lower.includes("musk") || lower.includes("tweet")) return 'SOCIAL';

    // 🔥 EL FIX QUANT: Diccionario masivo con límites de palabra (\b) para evitar falsos positivos
    if (/\b(nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|wwe|mma|league|champions|madrid|lakers|yankees|athletics|club|fc|cf|atp|wta|tour|match|inning|halftime|half-time|quarter|basketball|football|baseball|hockey|fifa|uefa|goals|points|rebounds|assists|touchdown|spread|over\/under|o\/u)\b/i.test(lower)) return 'SPORTS';
    if (lower.includes(" vs ") || lower.includes(" vs. ")) return 'SPORTS'; 

    return null;
}

// 🛡️ ESCÁNER DE PERMISOS (VERSIÓN BLINDADA QUANT)
function isMarketAllowed(title = "", slug = "") {
    const text = `${title} ${slug}`.toLowerCase();

    // Regex SÚPER AGRESIVO BLINDADO con el mismo diccionario de deportes
    const isSports = /\b(nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|wwe|mma|league|champions|madrid|lakers|yankees|athletics|club|fc|cf|atp|wta|tour|match|inning|halftime|half-time|quarter|basketball|football|baseball|hockey|fifa|uefa|goals|points|rebounds|assists|touchdown|spread|over\/under|o\/u)\b/i.test(text) || text.includes(" vs ") || text.includes(" vs. ") || text.includes("win on 202");
    
    // Categorías sanas
    const isCrypto = text.match(/btc|eth|sol|crypto|bitcoin|ethereum|airdrop|token|etf|binance|memecoin|doge|pepe/i);
    const isPolitics = text.match(/election|president|trump|biden|senate|gop|dem|politics|party|vote|poll|debate/i);
    const isPop = text.match(/movie|oscar|grammy|mrbeast|box office|pop culture|youtube|tiktok|spotify|billboard/i);
    const isBusiness = text.match(/fed|interest rate|inflation|cpi|business|elon|tesla|openai|gdp|economy|apple|microsoft/i);

    // 🔥 FILTRO QUANT 1: Bloquear mercados de conteo 
    const isCountingMarket = text.match(/truth social posts|tweets|posts from|how many times/i);
    if (isCountingMarket) return false;

    // 🔥 FILTRO QUANT 2: Anti-Scalping (Opciones binarias de minutos)
    const isMicroTimeframe = text.match(/\d{1,2}:\d{2}\s*(am|pm)?\s*-\s*\d{1,2}:\d{2}\s*(am|pm)?/i) || text.match(/up or down/i);
    if (isMicroTimeframe) return false;

    // 🔥 FILTRO QUANT 3: Anti-Clima y Ruido (Bloquea termómetros)
    const isWeather = text.match(/temperature|temperatura|weather|degrees|°c|°f|rain|snow|highest temperature|lowest temperature/i);
    if (isWeather) {
        // console.log(`🚫 [ANTI-NOISE] Mercado de clima bloqueado: ${title.substring(0, 30)}...`);
        return false;
    }

    // Si el filtro de deportes está APAGADO en el panel frontal, bloqueamos a la menor provocación
    if (isSports && !botStatus.marketFilters.sports) return false;
    
    if (isCrypto && !botStatus.marketFilters.crypto) return false;
    if (isPolitics && !botStatus.marketFilters.politics) return false;
    if (isPop && !botStatus.marketFilters.pop) return false;
    if (isBusiness && !botStatus.marketFilters.business) return false;

    return true; 
}

// ==========================================
// 7. ACTUALIZACIÓN DE WATCHLIST - VERSIÓN MEJORADA (Prioridad Real)
// ==========================================
async function refreshWatchlist() {
    try {
        botStatus.currentTopic = 'Buscando oportunidades de alta calidad...';
        console.log(`\n⏰ [SNIPER] Escaneando mercado con prioridad en Política y Business...`);

        const res = await axios.get(
            'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=1000&order=volume&dir=desc',
            { httpsAgent: agent }
        );

        const now = Date.now();

        const futureMarkets = res.data.filter(m => {
            if (!m.conditionId || !m.endDate) return false;
            const endTime = new Date(m.endDate).getTime();
            const hoursLeft = (endTime - now) / (1000 * 60 * 60);
            
            const cat = getMarketCategoryEnhanced(m.question);
            
            // 🔥 MEJORA QUANT: Visión a 30 días (720 hrs) para Macro, 4 días (96 hrs) para Crypto/Ruido
            if (["POLITICS", "BUSINESS", "GEOPOLITICS", "TRUMP", "FED", "CPI", "IRAN", "UKRAINE", "ISRAEL"].includes(cat)) {
                return endTime > now && hoursLeft <= 720; 
            }
            return endTime > now && hoursLeft <= 96;   
        });

        // Categorizamos
        const marketsWithCategory = futureMarkets.map(m => ({
            ...m,
            category: getMarketCategoryEnhanced(m.question)
        }));

        // ==================== FILTRADO INTELIGENTE ====================
        let highQuality = [];   // Política, Trump, Fed, Geopolítica, Business
        let shortTermCrypto = []; // Crypto corto y Up or Down

        for (const market of marketsWithCategory) {
            // 🔥 FIX QUANT: Ignorar mercados ilíquidos (Menos de $2000 USD de volumen total)
            if (parseFloat(market.volume || 0) < 2000) continue;

            const cat = market.category || "";

            if (["POLITICS", "BUSINESS", "GEOPOLITICS", "TRUMP", "FED", "CPI", "IRAN", "UKRAINE", "ISRAEL"].includes(cat)) {
                highQuality.push(market);
            } 
            else if (cat === "CRYPTO" || cat === "SHORT_TERM" || market.question.toLowerCase().includes("up or down") || market.question.toLowerCase().includes("above")) {
                shortTermCrypto.push(market);
            }
        }

        // Ordenamos highQuality por volumen descendente
        highQuality.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));

        // Limitamos fuertemente los crypto cortos
        shortTermCrypto.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));
        shortTermCrypto = shortTermCrypto.slice(0, 6);   // Máximo 6 mercados crypto corto

        // Armamos el pool final: primero alta calidad, luego pocos crypto
        const finalPool = [...highQuality.slice(0, 40), ...shortTermCrypto];  

        // Convertimos al formato que usa el bot
        const rawTrends = finalPool.map(market => {
            const hrs = hoursUntilClose(market.endDate);
            const tokens = JSON.parse(market.clobTokenIds || "[]");
            const prices = JSON.parse(market.outcomePrices || "[]");

            return {
                title: market.question,
                category: market.category,
                conditionId: market.conditionId,
                tokenYes: tokens[0] || null,
                tokenNo: tokens[1] || null,
                priceYes: parseFloat(prices[0] || 0),
                priceNo: parseFloat(prices[1] || 0),
                tokenId: tokens[0] || null,
                marketPrice: parseFloat(prices[0] || 0),
                endDate: market.endDate, 
                endsIn: hrs < 1 ? `${Math.round(hrs*60)}m` : `${hrs.toFixed(1)}h`,
                tickSize: market.minimum_tick_size || "0.01",
                volume: parseFloat(market.volume || 0)
            };
        });

        botStatus.watchlist = rawTrends;

        // Log corregido para reflejar los límites aplicados
        console.log(`🎯 Pool seleccionado: ${rawTrends.length} mercados (${Math.min(highQuality.length, 40)} Alta Calidad + ${shortTermCrypto.length} Crypto Corto)`);

    } catch (e) {
        console.error('❌ Error refreshWatchlist:', e.message);
    }
}

// ==========================================
// 8. EJECUCIÓN DE COMPRA - VERSIÓN DINÁMICA Y SEGURA
// ==========================================
async function executeTradeOnChain(conditionId, tokenId, amountUsdc, currentPrice, marketTickSize = "0.01") {
    try {
        console.log(`\n--- ⚖️ EJECUCIÓN ON-CHAIN EN POLYMARKET ---`);

        if (!clobClient) throw new Error("clobClient no está inicializado.");

        // 1. Auto-limpieza
        // console.log("🧹 Liberando USDC de órdenes anteriores...");
        // try { await clobClient.cancelAll(); } catch (e) {}

        // 2. Datos del mercado
        let trueTickSize = String(marketTickSize);
        let minOrderSize = 5; // Fallback por defecto si la API no lo informa
        let isNegRisk = false;

        try {
            const clobMarket = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
            if (clobMarket.data) {
                if (clobMarket.data.neg_risk === true) isNegRisk = true;
                
                // 🔥 FIX: Leemos el mínimo exigido directamente de la blockchain de Polymarket
                if (clobMarket.data.minimum_order_size) {
                    minOrderSize = parseFloat(clobMarket.data.minimum_order_size);
                }

                if (clobMarket.data.tokens) {
                    const tokenData = clobMarket.data.tokens.find(t => t.token_id === tokenId);
                    if (tokenData?.minimum_tick_size) trueTickSize = tokenData.minimum_tick_size;
                }
            }
        } catch (e) {}

        const safeTickSize = String(trueTickSize);
        const decimales = safeTickSize === "0.001" ? 3 : (safeTickSize === "0.0001" ? 4 : 2);
        const minPriceAllowed = parseFloat(safeTickSize);

        let basePrice = Number(parseFloat(currentPrice).toFixed(decimales));

        if (basePrice < minPriceAllowed) {
            console.log(`⚠️ Mercado fantasma ($${basePrice}). Ignorando.`);
            return { success: false, error: "Precio inválido" };
        }

        // Slippage
        const entrySlippagePct = botStatus.riskSettings.entrySlippage || 5;
        let limitPrice = basePrice * (1 + entrySlippagePct / 100);
        if (limitPrice > 0.99) limitPrice = 0.99;
        limitPrice = Number(limitPrice.toFixed(decimales));

        // ====================== CÁLCULO DINÁMICO DE SHARES ======================
        let targetAmount = parseFloat(amountUsdc);           
        let numShares = Number((targetAmount / limitPrice).toFixed(3));

        // 🔥 FIX: Respetamos el mínimo dinámico del mercado, NO el 5 fijo
        if (numShares < minOrderSize) {
            numShares = minOrderSize;
            console.log(`⚠️ Ajustando al mínimo del mercado (${minOrderSize} shares) → Monto real: $${(minOrderSize * limitPrice).toFixed(2)}`);
        }

        console.log(`📡 Orden BUY: ${numShares} shares | Target: $${basePrice} | Monto real: $${(numShares * limitPrice).toFixed(2)}`);

        const response = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: limitPrice,
                side: Side.BUY,
                size: numShares,
            },
            { 
                tickSize: safeTickSize, 
                negRisk: isNegRisk 
            }, 
            OrderType.GTC
        );

        if (response && response.success) {
            console.log(`🎉 ¡ORDEN ACEPTADA! Order ID: ${response.orderID}`);
            return { success: true, hash: response.orderID };
        } else {
            throw new Error(`Orden rechazada: ${JSON.stringify(response)}`);
        }

    } catch (error) {
        console.error("❌ Error en executeTradeOnChain:", error.message);
        throw error;
    }
}

// ==========================================
// 8.5 EJECUCIÓN DE VENTA (VERSIÓN PULIDA)
// ==========================================
const recentlySoldTokens = new Set();

async function executeSellOnChain(conditionId, tokenId, exactShares, limitPrice, marketTickSize = "0.01") {
    try {
        if (recentlySoldTokens.has(tokenId)) {
            console.log(`      ⏳ Token en cooldown. Venta ignorada.`);
            return { success: false, reason: "COOLDOWN_ACTIVE" };
        }

        console.log(`\n--- 🔴 EJECUCIÓN DE VENTA ON-CHAIN ---`);

        let sharesToSell = parseFloat(exactShares);
        if (sharesToSell <= 0) return { success: false, reason: "NO_SHARES" };

        // Obtener saldo real
        let realBalance = 0;
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=50`);
            const positions = await response.json();
            const targetPos = positions.find(p => p.asset === tokenId || p.token_id === tokenId);
            if (targetPos) realBalance = parseFloat(targetPos.size || 0);
        } catch (e) {}

        if (realBalance > 0 && sharesToSell > realBalance) sharesToSell = realBalance;

        sharesToSell = Math.max(0, Math.floor((sharesToSell - 0.01) * 100) / 100);

        if (sharesToSell <= 0) {
            recentlySoldTokens.add(tokenId);
            return { success: false, reason: "LOW_BALANCE" };
        }

        // Configuración de tick y precio
        let trueTickSize = marketTickSize;
        let isNegRisk = false;

        try {
            const clobMarket = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
            if (clobMarket.data) {
                isNegRisk = clobMarket.data.neg_risk === true;
                const tokenData = clobMarket.data.tokens?.find(t => t.token_id === tokenId);
                if (tokenData?.minimum_tick_size) trueTickSize = tokenData.minimum_tick_size;
            }
        } catch (e) {}

        const decimales = trueTickSize === "0.001" ? 3 : (trueTickSize === "0.0001" ? 4 : 2);
        let safeLimitPrice = Number(parseFloat(limitPrice).toFixed(decimales));
        if (safeLimitPrice <= 0) safeLimitPrice = parseFloat(trueTickSize);

        console.log(`📡 Orden SELL: ${sharesToSell} shares | Precio: $${safeLimitPrice}`);

        const response = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: safeLimitPrice,
                side: Side.SELL,
                size: sharesToSell,
            },
            { tickSize: String(trueTickSize), negRisk: isNegRisk },
            OrderType.GTC
        );

        if (response && response.success) {
            console.log(`🎉 ¡VENTA ACEPTADA! Order ID: ${response.orderID}`);
            recentlySoldTokens.add(tokenId);
            setTimeout(() => recentlySoldTokens.delete(tokenId), 3 * 60 * 1000);
            return { success: true, hash: response.orderID };
        } else {
            throw new Error(`Orden rechazada: ${JSON.stringify(response)}`);
        }

    } catch (error) {
        console.error("❌ Error en executeSellOnChain:", error.message);
        throw error;
    }
}

// ==========================================
// 9. Función para recuperar trades reales
// ==========================================
async function fetchRealTrades() {
    const PROXY_WALLET = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
    
    try {
        // Solo mostramos este log ocasionalmente para reducir spam en consola
        if (Math.random() < 0.25) {
            console.log("📡 Sincronizando historial de transacciones...");
        }

        const response = await axios.get(
            `https://data-api.polymarket.com/trades?user=${PROXY_WALLET}&limit=15`, 
            { httpsAgent: agent, timeout: 7000 }
        );

        const rawTrades = response.data.data || response.data.trades || response.data || [];

        if (Array.isArray(rawTrades) && rawTrades.length > 0) {
            botStatus.executions = rawTrades.map((trade) => {
                const hash = trade.transactionHash || trade.transaction_hash || trade.id || "0x00000000";
                const title = trade.title || "Mercado desconocido";
                const tokenId = trade.asset || trade.asset_id || trade.token_id;
                
                const side = (trade.side || "BUY").toUpperCase();
                const shares = parseFloat(trade.size || 0);
                const tradePrice = parseFloat(trade.price || 0);
                const transactionValue = shares * tradePrice;

                const outcomeStr = trade.outcome || "Unknown";
                const timestampMs = trade.timestamp 
                    ? (String(trade.timestamp).length === 10 ? parseInt(trade.timestamp) * 1000 : parseInt(trade.timestamp)) 
                    : Date.now();

                let estadoOperacion = side === "SELL" ? "Vendido" : "Comprado";

                if (side === "BUY") {
                    // Si el precio actual es 0, asumimos que el mercado ya resolvió en contra
                    // (esto es aproximado, pero útil)
                    estadoOperacion = "Comprado"; 
                }

                return {
                    id: hash.substring(0, 10),
                    tokenId: tokenId,
                    time: new Date(timestampMs).toLocaleTimeString(),
                    market: title.length > 65 ? title.substring(0, 62) + "..." : title,
                    outcome: outcomeStr,
                    price: tradePrice,
                    shares: shares.toFixed(1),
                    side: side,
                    inversion: Number(transactionValue.toFixed(2)),
                    status: estadoOperacion
                };
            });
        } else {
            // Si no hay trades nuevos, mantenemos los que ya tenemos (evita borrar historial)
            if (botStatus.executions.length === 0) {
                botStatus.executions = [];
            }
        }

    } catch (e) {
        if (e.code === 'ECONNABORTED' || e.response?.status === 408 || e.response?.status === 429) {
            console.log("⚠️ Timeout o rate limit en API de trades. Saltando...");
        } else {
            console.error("❌ Error actualizando historial de trades:", e.message);
        }
    }
}

// ==========================================
// AUTO COPY-TRADING - SELECCIÓN AUTOMÁTICA DE WHALES
// ==========================================
async function autoSelectTopWhales() {
    if (!botStatus.copyTradingAutoEnabled) return;   // ← Solo se ejecuta si el Auto está ON

    console.log(`🔍 [AUTO-WHALE] Seleccionando las mejores ballenas automáticamente...`);

    try {
        const response = await axios.get(
            'https://data-api.polymarket.com/v1/leaderboard?timePeriod=WEEK&orderBy=PNL&limit=50',
            { httpsAgent: agent, timeout: 10000 }
        );

        const traders = response.data || [];

        const goodWhales = traders
            .filter(t => {
                const address = t.proxyWallet;
                const pnl = parseFloat(t.pnl || 0);
                const volume = parseFloat(t.vol || 0);

                return address && 
                       address.startsWith('0x') &&
                       pnl > 500000 && 
                       volume > 500000;
            })
            .sort((a, b) => parseFloat(b.pnl || 0) - parseFloat(a.pnl || 0))
            .slice(0, botStatus.maxWhalesToCopy || 5);

        botStatus.autoSelectedWhales = goodWhales.map(t => ({
            address: t.proxyWallet,
            pnl: parseFloat(t.pnl || 0),
            winRate: 0.55,
            volume: parseFloat(t.vol || 0)
        }));

        botStatus.lastWhaleSelection = new Date().toLocaleTimeString();

        console.log(`✅ [AUTO-WHALE] Seleccionadas ${botStatus.autoSelectedWhales.length} ballenas completas:`);
        botStatus.autoSelectedWhales.forEach((w, i) => {
            console.log(`   ${i+1}. ${w.address} | PnL: $${w.pnl.toLocaleString()} | Vol: $${w.volume.toLocaleString()}`);
        });

    } catch (error) {
        console.error("❌ Error consultando leaderboard:", error.message);
    }
}

// ==========================================
// LIMPIEZA DE ESTADO - Sincronizar copiedTrades vs copiedPositions
// ==========================================
async function cleanupCopiedState() {
    if (!botStatus.copiedTrades || !botStatus.copiedPositions) return;

    const activeTokenIds = new Set(botStatus.copiedPositions.map(p => p.tokenId));

    // Remover de copiedTrades los que ya no están en posiciones activas NI en activePositions reales
    botStatus.copiedTrades = botStatus.copiedTrades.filter(trade => {
        const stillActive = activeTokenIds.has(trade.tokenId) ||
                            botStatus.activePositions.some(pos => pos.tokenId === trade.tokenId);
        
        if (!stillActive) {
            console.log(`🧹 [CLEANUP] Removiendo trade huérfano: ${trade.market.substring(0,40)}...`);
        }
        return stillActive;
    });

    // Opcional: Limpiar duplicados en copiedTrades
    const seen = new Set();
    botStatus.copiedTrades = botStatus.copiedTrades.filter(trade => {
        const key = trade.tokenId + trade.txHash;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    saveConfigToDisk("Cleanup de copied state");
}

// ==========================================
// FUNCIÓN AUXILIAR PARA ALERTAS DE COPY TRADING (BUY + SELL)
async function sendCopyAlert(type, whaleName, marketTitle, amount) {
    let emoji = '';
    let titulo = '';

    if (type === 'BUY') {
        emoji = '🐋';
        titulo = '*COPY BUY*';
        amount = `Inversión: *$${amount}* USDC`;
    } else if (type === 'SELL') {
        emoji = '🛑';
        titulo = '*COPY SELL*';
        amount = `Rescatado: *$${amount}* USDC`;
    }

    const marketClean = marketTitle.length > 68 
        ? marketTitle.substring(0, 65) + '...' 
        : marketTitle;

    const msg = `${emoji} ${titulo}\n\n` +
                `📛 *Ballena:* ${whaleName}\n` +
                `📋 *Mercado:* ${marketClean}\n` +
                `💰 ${amount}`;

    try {
        await telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(`❌ Error enviando alerta COPY ${type}:`, e.message);
    }
}


// ==========================================
// CHECK AND COPY WHALE TRADES - VERSIÓN QUANT (Anti-Ametralladora + Anti-Iceberg)
// ==========================================
let isScanningWhales = false;

async function checkAndCopyWhaleTrades() {
    if (isScanningWhales) return;

    // =========================================================
    // 🧹 FIX QUANT: RUTINA DE SINCRONIZACIÓN DE MEMORIA
    // Compara las posiciones reales activas con el registro de ballenas.
    // Si vendiste manualmente, esto elimina a los "fantasmas".
    // =========================================================
    if (botStatus.copiedPositions && botStatus.activePositions) {
        const activeTokens = new Set(botStatus.activePositions.map(p => p.tokenId));
        const originalCount = botStatus.copiedPositions.length;
        
        botStatus.copiedPositions = botStatus.copiedPositions.filter(cp => activeTokens.has(cp.tokenId));
        
        if (originalCount !== botStatus.copiedPositions.length) {
            console.log(`🧹 [SYNC] Memoria de Ballenas purgada. Se borraron ${originalCount - botStatus.copiedPositions.length} trades huérfanos (venta manual detectada).`);
            saveConfigToDisk("Limpieza de fantasmas CopyTrading");
        }
    }
    // =========================================================

    const hasActiveCopiedPositions = (botStatus.copiedPositions || []).length > 0;

    if (!botStatus.copyTradingCustomEnabled && 
        !botStatus.copyTradingAutoEnabled && 
        !hasActiveCopiedPositions) return;

    isScanningWhales = true;

    try {
        let allWhales = [];

        if (botStatus.copyTradingAutoEnabled) {
            if (!botStatus.autoSelectedWhales || botStatus.autoSelectedWhales.length === 0 ||
                !botStatus.lastWhaleSelection || 
                (Date.now() - new Date(botStatus.lastWhaleSelection).getTime()) > 10 * 60 * 1000) {
                await autoSelectTopWhales();
            }
            allWhales = [...(botStatus.autoSelectedWhales || [])];
        }

        const enabledCustom = (botStatus.customWhales || []).filter(w => w.enabled === true);
        allWhales = allWhales.concat(enabledCustom);

        const seen = new Set();
        allWhales = allWhales.filter(whale => {
            const addr = whale.address.toLowerCase();
            if (seen.has(addr)) return false;
            seen.add(addr);
            return true;
        });

        if (allWhales.length === 0) {
            isScanningWhales = false;
            return;
        }

        console.log(`🔄 [COPY-TRADING] Revisando trades de ${allWhales.length} ballenas (Custom: ${botStatus.copyTradingCustomEnabled ? '✅ ON' : '❌ OFF'} | Auto: ${botStatus.copyTradingAutoEnabled ? '✅ ON' : '❌ OFF'})...`);

        // ====================== HELPER MEJORADO PARA NICKNAME ======================
        const getWhaleDisplayName = (whale) => {
            if (whale.nickname && whale.nickname.trim() !== '') {
                return whale.nickname;
            }
            const configWhale = botStatus.customWhales.find(w => 
                w.address.toLowerCase() === whale.address.toLowerCase()
            );
            if (configWhale && configWhale.nickname && configWhale.nickname.trim() !== '') {
                return configWhale.nickname;
            }
            return whale.address.substring(0, 8) + "...";
        };
        // =======================================================================

        for (const whale of allWhales) {
            try {
                // 🔥 FIX VITAL: Debe ser 'let' y no 'const' para que el Freno Dinámico pueda sumar
                let copiedFromThisWhale = botStatus.copiedPositions.filter(p => 
                    p.whale && p.whale.toLowerCase() === whale.address.toLowerCase()
                ).length;

                const limitPerWhale = botStatus.maxCopyMarketsPerWhale || 1;

                if (limitPerWhale > 0 && copiedFromThisWhale >= limitPerWhale) {
                    console.log(`⛔ [COPY LIMIT] Ballena ${getWhaleDisplayName(whale)} ya tiene ${copiedFromThisWhale} mercados activos (límite: ${limitPerWhale})`);
                    continue;
                }

                const response = await axios.get(
                    `https://data-api.polymarket.com/trades?user=${whale.address}&limit=12`,
                    { httpsAgent: agent, timeout: 8000 }
                );

                const recentTrades = Array.isArray(response.data) 
                    ? response.data 
                    : (response.data.data || response.data.trades || []);

                // ==========================================================
                // 🔥 NUEVO RADAR DE ACTIVIDAD: Registrar el último movimiento
                // ==========================================================
                if (recentTrades.length > 0) {
                    const latestTrade = recentTrades[0];
                    const lastTimestamp = String(latestTrade.timestamp).length === 10 
                        ? parseInt(latestTrade.timestamp) * 1000 
                        : parseInt(latestTrade.timestamp);
                    
                    const customWhaleIndex = botStatus.customWhales.findIndex(w => 
                        w.address.toLowerCase() === whale.address.toLowerCase()
                    );
                    
                    if (customWhaleIndex !== -1) {
                        botStatus.customWhales[customWhaleIndex].lastActive = lastTimestamp;
                    }
                }
                // ==========================================================

                // 🔥 FIX QUANT: Memoria temporal para ignorar órdenes "Iceberg"
                const uniqueMarketsCopiedNow = new Set(); 

                for (const trade of recentTrades) {
                    if (!trade) continue;

                    const side = (trade.side || "").toUpperCase();
                    const tokenId = trade.asset || trade.token_id;
                    const conditionId = trade.conditionId;
                    const whaleSize = parseFloat(trade.size || 0);
                    const price = parseFloat(trade.price || 0);
                    const txHash = trade.transactionHash || trade.id || '';

                    const timestamp = String(trade.timestamp).length === 10 
                        ? parseInt(trade.timestamp) * 1000 
                        : parseInt(trade.timestamp);

                    const title = trade.title || "Mercado desconocido";

                    if (!tokenId || whaleSize < botStatus.copyMinWhaleSize) continue;
                    if (Date.now() - timestamp > botStatus.copyTimeWindowMinutes * 60 * 1000) continue;

                    // =========================================================
                    // 🔥 FIX QUANT: ESCUDO ANTI-ESTANCAMIENTO (Caza de Flujo)
                    // =========================================================
                    // Obligamos al Copy-Trading a respetar los filtros de la Watchlist.
                    // Si el mercado no está en la Watchlist, significa que expira en más de 30 días, 
                    // o tiene menos de $2000 de liquidez. Lo descartamos automáticamente.
                    const isMarketInRadar = botStatus.watchlist.some(m => m.conditionId === conditionId);
                    if (!isMarketInRadar) {
                        // Opcional: console.log(`⏩ [COPY SKIP] Ballena operando basura ilíquida o a largo plazo: ${title.substring(0,30)}`);
                        continue; 
                    }

                    // ==================== COPIA DE COMPRA ====================
                    if (side === "BUY") {

                        // 🔥 FIX QUANT: Respetar los Master Switches estrictamente para NUEVAS compras
                        const isAutoWhale = (botStatus.autoSelectedWhales || []).some(w => w.address.toLowerCase() === whale.address.toLowerCase());
                        const isCustomWhale = (botStatus.customWhales || []).some(w => w.address.toLowerCase() === whale.address.toLowerCase());
                        
                        if (isAutoWhale && !botStatus.copyTradingAutoEnabled) {
                            continue; // Ignora la compra si el Auto está apagado
                        }
                        if (isCustomWhale && !botStatus.copyTradingCustomEnabled) {
                            continue; // Ignora la compra si el Custom está apagado
                        }

                        // 🔥 FIX QUANT: Freno Dinámico en Tiempo Real (Anti-Ametralladora)
                        if (limitPerWhale > 0 && copiedFromThisWhale >= limitPerWhale) {
                            console.log(`⛔ [COPY LIMIT] Freno de ráfaga activado. ${getWhaleDisplayName(whale)} intentó abrir más de ${limitPerWhale} mercados de golpe.`);
                            break; // 🛑 Rompe el bucle instantáneamente
                        }

                        // 🔥 FIX QUANT: Filtro Anti-Duplicación (Ignorar Icebergs)
                        if (uniqueMarketsCopiedNow.has(tokenId)) {
                            // Silenciosamente ignoramos este pedazo de la orden porque ya lo compramos
                            continue; 
                        }

                        if (botStatus.isPanicStopped) continue;
                        if (!isMarketAllowed(title)) continue;

                        // Lógica de Límite de Deportes
                        const marketCat = getMarketCategoryEnhanced(title);
                        if (marketCat === 'SPORTS' && botStatus.maxActiveSportsMarkets > 0) {
                            const activeSportsCount = botStatus.activePositions.filter(p => p.category === 'SPORTS').length;
                            if (activeSportsCount >= botStatus.maxActiveSportsMarkets) {
                                console.log(`⚠️ [LIMITE COPY] Omitiendo deporte de ballena: ${title.substring(0,30)}`);
                                continue;
                            }
                        }

                        const alreadyHavePosition = botStatus.activePositions.some(p => p.tokenId === tokenId);
                        const alreadyCopied = botStatus.copiedTrades.some(t => t.txHash === txHash);
                        const alreadyPending = pendingOrdersCache.has(tokenId);

                        if (alreadyHavePosition || alreadyCopied || alreadyPending) continue;

                        const { config: riskConfig } = getRiskProfile(title, true);
                        const currentBalance = parseFloat(botStatus.clobOnlyUSDC || 0);

                        const maxPct = riskConfig.maxCopyPercentOfBalance || 8; 
                        const maxAllowedPercent = currentBalance * (maxPct / 100);
                        
                        let montoInversion = Math.min(riskConfig.maxCopySize || 50, maxAllowedPercent);
                        if (montoInversion < 1) montoInversion = 1;

                        // =========================================================
                        // 🛡️ EL ESCUDO DE RESERVA DINÁMICO PARA LA IA (FIDEICOMISO)
                        // =========================================================
                        const RESERVE_FOR_AI = botStatus.aiReserveAmount !== undefined ? botStatus.aiReserveAmount : 50; 
                        
                        if (currentBalance - montoInversion < RESERVE_FOR_AI) {
                            console.log(`🛡️ [RESERVA IA] Saldo libre ($${currentBalance.toFixed(2)}) muy cerca de la reserva sagrada ($${RESERVE_FOR_AI}). Copy Trading bloqueado.`);
                            isScanningWhales = false; 
                            return; // 🛑 Aborta la copia actual y expulsa a las demás ballenas en este escaneo
                        }

                        if (currentBalance < montoInversion) continue;

                        let limitPrice = price * 1.04;

                        if (limitPrice > 0.99) limitPrice = 0.99;

                        const lastTradeTime = botStatus.lastTrades[tokenId];
                        if (lastTradeTime) {
                            const minutesSince = (Date.now() - lastTradeTime) / 60000;
                            if (minutesSince < botStatus.riskSettings.tradeCooldownMin) {
                                console.log(`⏳ COOLDOWN: Esperando ${Math.ceil(botStatus.riskSettings.tradeCooldownMin - minutesSince)}m para re-entrar en ${tokenId}`);
                                continue; 
                            }
                        }

                        console.log(`🔥 [COPY BUY] ${getWhaleDisplayName(whale)} → ${title.substring(0,45)}... (Copiados de esta ballena: ${copiedFromThisWhale}/${limitPerWhale})`);

                        const result = await executeTradeOnChain(conditionId, tokenId, montoInversion, limitPrice, "0.01");

                        if (result?.success) {
                            pendingOrdersCache.add(tokenId);
                            setTimeout(() => pendingOrdersCache.delete(tokenId), 60000); // 🔥 FIX VITAL: Limpieza Cuántica olvidada
                            
                            // 🔥 Actualizamos el contador en tiempo real
                            copiedFromThisWhale++;

                            // 🔥 Guardamos el ID del mercado para no volver a comprarlo en esta ráfaga
                            uniqueMarketsCopiedNow.add(tokenId);

                            botStatus.copiedTrades.unshift({
                                id: Date.now(),
                                txHash,
                                whale: whale.address.substring(0,10) + "...",
                                nickname: whale.nickname || getWhaleDisplayName(whale),
                                tokenId,
                                size: montoInversion,
                                price: limitPrice,
                                time: new Date().toLocaleTimeString(),
                                market: title
                            });

                            if (botStatus.copiedTrades.length > 20) botStatus.copiedTrades.pop();

                            botStatus.copiedPositions.push({
                                tokenId,
                                whale: whale.address,
                                nickname: whale.nickname || getWhaleDisplayName(whale),
                                sizeCopied: montoInversion,
                                priceEntry: limitPrice,
                                marketName: title
                            });

                            saveConfigToDisk("Nueva Ballena Copiada");

                            botStatus.copyTradingStats.totalCopied = (botStatus.copyTradingStats.totalCopied || 0) + 1;
                            botStatus.copyTradingStats.successful = (botStatus.copyTradingStats.successful || 0) + 1;

                            await sendCopyAlert('BUY', getWhaleDisplayName(whale), title, montoInversion.toFixed(2));

                            botStatus.lastTrades[tokenId] = Date.now();
                        }
                    }

                    // ==================== COPIA DE VENTA ====================
                    else if (side === "SELL") {
                        const copiedIndex = botStatus.copiedPositions.findIndex(p => 
                            p.tokenId === tokenId && p.whale === whale.address
                        );
                        if (copiedIndex === -1) continue;

                        const position = botStatus.copiedPositions[copiedIndex];

                        let limitSellPrice = price * 0.97;
                        if (limitSellPrice < 0.01) limitSellPrice = 0.01;

                        const sellResult = await executeSellOnChain(conditionId, tokenId, position.sizeCopied, limitSellPrice, "0.01");

                        if (sellResult?.success) {
                            botStatus.copiedPositions.splice(copiedIndex, 1);
                            saveConfigToDisk("Ballena Vendida");

                            const rescateEst = (position.sizeCopied * limitSellPrice).toFixed(2);

                            await sendCopyAlert('SELL', position.nickname || getWhaleDisplayName(whale), title, rescateEst);
                        }
                    }
                }
            } catch (err) {
                if (!err.message.includes('429') && !err.message.includes('timeout')) {
                    console.error(`❌ Error whale ${getWhaleDisplayName(whale)}:`, err.message);
                }
            }
        }
    } finally {
        isScanningWhales = false;
        await cleanupCopiedState();
        saveConfigToDisk("Actualización de Actividad de Ballenas");
    }
}

// ==========================================
// GET RISK PROFILE - VERSIÓN FINAL CORREGIDA
// ==========================================
function getRiskProfile(marketName = "", isWhale = false) {
    const text = (marketName || "").toLowerCase();
    const isVolatile = /nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|league|champions|madrid|lakers|sports|pop|movie|oscar|grammy|temperature|temperatura/i.test(text);
    const profileType = isVolatile ? 'volatile' : 'standard';
    
    let config = isWhale 
        ? { ...botStatus.whaleConfig[profileType] } 
        : { ...botStatus.aiConfig[profileType] };

    const customRule = getCustomMarketRules(marketName);
    
    if (customRule) {
        config.takeProfitThreshold = customRule.takeProfitThreshold;
        config.stopLossThreshold   = customRule.stopLossThreshold;
        config.microBetAmount      = customRule.microBetAmount || config.microBetAmount;
        
        // 🔥 NUEVO: Asignar Edge y Prob solo si existen en la regla (Si no, mantiene el de config base)
        if (customRule.edgeThreshold !== undefined) config.edgeThreshold = customRule.edgeThreshold;
        if (customRule.predictionThreshold !== undefined) config.predictionThreshold = customRule.predictionThreshold;
    }

    return {
        config: config,
        profileType: profileType,
        usedCustomRule: !!customRule   
    };
}

// ==========================================
// NUEVA FUNCIÓN: Reglas personalizadas por mercado (Parche #8 FINAL)
// ==========================================
function getCustomMarketRules(marketTitle = "") {
    if (!botStatus.customMarketRules || botStatus.customMarketRules.length === 0) return null;

    const titleLower = marketTitle.toLowerCase();

    for (const rule of botStatus.customMarketRules) {
        if (titleLower.includes(rule.keyword.toLowerCase())) {
            console.log(`📋 [CUSTOM RULE] Aplicada → ${marketTitle}`);
            return {
                takeProfitThreshold: rule.takeProfitThreshold,
                stopLossThreshold: rule.stopLossThreshold,
                microBetAmount: rule.microBetAmount,
                edgeThreshold: rule.edgeThreshold,             // 🔥 NUEVO
                predictionThreshold: rule.predictionThreshold  // 🔥 NUEVO
            };
        }
    }
    return null;
}

// ==========================================
// 10. CICLO PRINCIPAL (EL CEREBRO DEL BOT)
// ==========================================
let watchlistIndex = 0;

async function runBot() {

    if (botStatus.isPanicStopped) {
        console.log("🚨 [MODO PÁNICO] Compras bloqueadas. Ejecutando únicamente motor de ventas (TP/SL)...");
        try { await autoSellManager(); } catch (e) { console.log("Error autoSell:", e); }
        return; 
    }

    botStatus.lastCheck = new Date().toLocaleTimeString();

    try {
        await fetchRealTrades();
        await updateRealBalances();
        await cleanupCopiedState();

        // 2. Copy-Trading (Auto + Custom)
        if (botStatus.copyTradingCustomEnabled || 
            botStatus.copyTradingAutoEnabled || 
            (botStatus.copiedPositions && botStatus.copiedPositions.length > 0)) {
            
            if (botStatus.copyTradingAutoEnabled) {
                if (!botStatus.lastWhaleSelection || 
                    (Date.now() - new Date(botStatus.lastWhaleSelection).getTime()) > 15 * 60 * 1000) {
                    await autoSelectTopWhales();
                }
            }
            await checkAndCopyWhaleTrades();
        }

        await checkDailyLossLimit();

        if (botStatus.autoTradeEnabled) {
            await autoSellManager();
        }

        // 3. Refresh Watchlist
        if (botStatus.watchlist.length === 0 || watchlistIndex >= botStatus.watchlist.length) {
            await refreshWatchlist();
            watchlistIndex = 0;
        }

        const marketItem = botStatus.watchlist[watchlistIndex];
        if (!marketItem || !marketItem.tokenId) {
            watchlistIndex++;
            return;
        }

        const marketTitle = marketItem.title;
        botStatus.currentMarket = marketItem;
        botStatus.currentTopic = marketTitle;

        // === OPTIMIZACIÓN QUANT: PRE-FILTRO DE PRECIO ===
        // Si ambos lados del mercado están fuera de nuestro rango operable (muy caros o muy baratos),
        // saltamos al siguiente mercado SIN gastar créditos de IA.
        const prePriceYes = marketItem.priceYes || 0;
        const prePriceNo = marketItem.priceNo || 0;
        
        if ((prePriceYes < 0.05 || prePriceYes > 0.85) && (prePriceNo < 0.05 || prePriceNo > 0.85)) {
            // console.log(`⏩ Saltando ${marketTitle.substring(0,30)}... Precios fuera de rango operable.`);
            watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
            return;
        }

        // ====================================================
        // 🧠 EJECUCIÓN MULTI-AGENTE (CLAUDE + GEMINI + GROK)
        // ====================================================
        const newsString = await getLatestNews(marketTitle, marketItem.category);
        const cacheKey = `${marketItem.tokenId}-${newsString.substring(0, 60)}`;

        let finalAnalysis;
        let useCache = false;

        if (analysisCache.has(cacheKey)) {
            const cached = analysisCache.get(cacheKey);
            const ageMinutes = (Date.now() - (cached.timestamp || 0)) / 60000;
            
            // Si el análisis tiene menos de 45 minutos, usamos el caché
            if (ageMinutes < 45) {
                finalAnalysis = cached;
                useCache = true;
                console.log(`♻️ Usando caché para ${marketTitle.substring(0,30)} (${Math.round(ageMinutes)}m de antigüedad)`);
            }
        }

        if (!useCache) {
            console.log(`\n🤖 Analizando con la Trinidad: ${marketTitle.substring(0,45)}...`);

            // Disparamos las 3 APIs al mismo tiempo por velocidad
            const [claudeResult, geminiResult, grokResult] = await Promise.all([
                analyzeMarketWithClaude(marketTitle, newsString),
                analyzeMarketWithGemini(marketTitle, newsString),
                analyzeMarketWithGrok(marketTitle, newsString)
            ]);

            // 🛡️ FIX QUANT: Purga de errores y Matriz de Supervivencia
            const validResults = [];
            if (!claudeResult.isError) validResults.push({ ...claudeResult, engine: "Claude", buy: claudeResult.recommendation.includes("BUY") });
            if (!geminiResult.isError) validResults.push({ ...geminiResult, engine: "Gemini", buy: geminiResult.recommendation.includes("BUY") });
            if (!grokResult.isError) validResults.push({ ...grokResult, engine: "Grok", buy: grokResult.recommendation.includes("BUY") });

            // 🚨 KILL SWITCH: Si las 3 APIs están caídas, abortamos para proteger el saldo
            if (validResults.length === 0) {
                console.log("🚫 [SNIPER ABORTADO] Las 3 IAs fallaron (Rate Limits). Protegiendo capital, no disparamos a ciegas.");
                watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                return;
            }

            // === FUSIÓN DE OPINIONES Y FALLBACK DINÁMICO ===
            const buyVotes = validResults.filter(r => r.buy).length;
            finalAnalysis = { prob: 0, edge: 0, recommendation: "WAIT", reason: "", urgency: 5, engine: "None" };

            // CASO A: Sobrevivieron al menos 2 modelos y están de acuerdo en COMPRAR (Consenso Dinámico)
            if (validResults.length >= 2 && buyVotes >= 2) {
                console.log(`🔥 ¡CONSENSO DINÁMICO FUERTE! (${buyVotes}/${validResults.length} votos válidos)`);
                
                const activeBuys = validResults.filter(r => r.buy);
                
                finalAnalysis.prob = activeBuys.reduce((sum, r) => sum + r.prob, 0) / buyVotes;
                finalAnalysis.edge = activeBuys.reduce((sum, r) => sum + r.edge, 0) / buyVotes;
                finalAnalysis.urgency = Math.max(...activeBuys.map(r => r.urgency));
                finalAnalysis.recommendation = "STRONG_BUY"; 
                finalAnalysis.reason = `[CONSENSO] ` + activeBuys.map(r => `${r.engine.charAt(0)}: ${r.reason}`).join(" | ");
                finalAnalysis.engine = buyVotes === 3 ? "Trinity (C+G+X)" : `Consenso (${activeBuys.map(r => r.engine.charAt(0)).join('+')})`;

            } else {
                // CASO B: CASCADA DE FALLBACK ESTRICTA (Si no hay consenso o cayeron modelos clave)
                const claudeValid = validResults.find(r => r.engine === "Claude");
                const geminiValid = validResults.find(r => r.engine === "Gemini");
                const grokValid = validResults.find(r => r.engine === "Grok");

                if (claudeValid) {
                    finalAnalysis = { ...claudeValid };
                } else if (geminiValid) {
                    console.log("⚠️ [FALLBACK] Claude saturado. Gemini asume el control del disparo.");
                    finalAnalysis = { ...geminiValid };
                } else if (grokValid) {
                    console.log("⚠️ [FALLBACK] Claude y Gemini saturados. Grok asume el control del disparo.");
                    finalAnalysis = { ...grokValid };
                }
            }

            // Almacenamos en caché el resultado sanitizado CON TIMESTAMP
            analysisCache.set(cacheKey, { ...finalAnalysis, timestamp: Date.now() });
            if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
        }

        botStatus.lastProbability = finalAnalysis.prob || 0;

        // === LÓGICA BIDIRECCIONAL (Sí / No) ===
        const probYes = finalAnalysis.prob || 0;
        const probNo = 1 - probYes;
        const priceYes = marketItem.priceYes || 0;
        const priceNo = marketItem.priceNo || 0;
        const edgeYes = priceYes > 0 ? probYes - priceYes : 0;
        const edgeNo = priceNo > 0 ? probNo - priceNo : 0;

        let bestEdge = edgeYes;
        let targetTokenId = marketItem.tokenYes;
        let targetPrice = priceYes;
        let targetProb = probYes;
        let targetSideLabel = "SÍ";

        if (edgeNo > edgeYes && edgeNo > 0.04) {
            bestEdge = edgeNo;
            targetTokenId = marketItem.tokenNo;
            targetPrice = priceNo;
            targetProb = probNo;
            targetSideLabel = "NO";
        }

        const livePrice = targetPrice;
        const edge = bestEdge;

        // ====================== FILTROS DE SEGURIDAD ======================
        if (!isMarketAllowed(marketTitle, marketItem.slug || "")) {
            watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
            return;
        }

        if (livePrice < 0.05 || livePrice > 0.85) {
            watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
            return;
        }

        const alreadyInvested = botStatus.activePositions.some(pos => pos.tokenId === targetTokenId);
        const alreadyClosed = closedPositionsCache.has(targetTokenId);
        const alreadyPending = pendingOrdersCache.has(targetTokenId); 

        // 🔥 FIX 1: OBTENEMOS PERFIL CON REGLAS CUSTOM INCLUIDAS
        const { config: profile, profileType, usedCustomRule } = getRiskProfile(marketTitle, false);

        const activeSportsCount = botStatus.activePositions.filter(p => p.category === 'SPORTS').length;
        const isSportsLimitReached = (marketItem.category === 'SPORTS' && 
                                     botStatus.maxActiveSportsMarkets > 0 && 
                                     activeSportsCount >= botStatus.maxActiveSportsMarkets);

        const isFlippedToNo = (targetSideLabel === "NO");

        // 🔥 FIX 2: FALLBACK MATEMÁTICO
        const minEdge = profile.edgeThreshold !== undefined ? profile.edgeThreshold : botStatus.aiConfig.standard.edgeThreshold;
        const minProb = profile.predictionThreshold !== undefined ? profile.predictionThreshold : botStatus.aiConfig.standard.predictionThreshold;

        // ====================== SEÑAL FUERTE (VERSIÓN INTELIGENTE CORREGIDA) ======================
        const isStrongSignal = 
            (!alreadyInvested && !alreadyClosed && !alreadyPending && !isSportsLimitReached) && (
                
                // CASO 1: Consenso Fuerte (Trinity o Dinámico)
                (finalAnalysis.engine && (finalAnalysis.engine.includes("Trinity") || finalAnalysis.engine.includes("Consenso")) && 
                 targetProb >= minProb - 0.05 && edge >= Math.max(0.04, minEdge - 0.015)) ||
                
                // CASO 2: Recomendación MUY FUERTE (STRONG_BUY).
                (finalAnalysis.recommendation === "STRONG_BUY" && 
                 targetProb >= minProb - 0.02 && edge >= minEdge + 0.015) ||
                
                // CASO 3: Recomendación NORMAL (BUY o Flipped).
                ((finalAnalysis.recommendation === "BUY" || isFlippedToNo) && 
                 targetProb >= minProb + 0.03 && edge >= minEdge + 0.005) ||
                
                // CASO 4: Urgencia Extrema (Noticias).
                (finalAnalysis.urgency >= 9 && 
                 targetProb >= minProb && edge >= minEdge - 0.01) ||

                // CASO 5: Oportunidad de Oro (Asimetría Extrema)
                (edge >= 0.20 && targetProb >= 0.60 && finalAnalysis.engine && (finalAnalysis.engine.includes("Consenso") || finalAnalysis.engine.includes("Trinity")))
            );

        if (isSportsLimitReached) {
            console.log(`⚠️ [LIMITE] Omitiendo ${marketTitle} (límite de deportes alcanzado)`);
        }

        // ====================== EJECUCIÓN DEL SNIPER ======================
        if (botStatus.autoTradeEnabled && isStrongSignal) {

            const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
            let dynamicBetAmount = profile.microBetAmount || 2.0;

            // Kelly Asimétrico
            if (edge > 0.25 && livePrice > 0 && livePrice < 1) {
                const kellyFraction = edge / (1 - livePrice);
                dynamicBetAmount = Math.min(
                    saldoLibre * kellyFraction * 0.20,   
                    saldoLibre * 0.05,                   
                    profile.microBetAmount * 5.0         
                );
            }

            dynamicBetAmount = Math.max(dynamicBetAmount, 0.5);
            dynamicBetAmount = Math.min(dynamicBetAmount, saldoLibre * 0.15);

            const lastTradeTime = botStatus.lastTrades[targetTokenId];
            if (lastTradeTime) {
                const minutesSince = (Date.now() - lastTradeTime) / 60000;
                if (minutesSince < botStatus.riskSettings.tradeCooldownMin) {
                    console.log(`⏳ COOLDOWN: Esperando ${Math.ceil(botStatus.riskSettings.tradeCooldownMin - minutesSince)}m`);
                    watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                    return; 
                }
            }

            console.log(`🎯 SNIPER DISPARO [${finalAnalysis.engine}] → [${targetSideLabel}] | Edge: ${(edge*100).toFixed(1)}% | Apuesta: $${dynamicBetAmount.toFixed(2)} ${usedCustomRule ? '(regla personalizada)' : '(global)'}`);

            const result = await executeTradeOnChain(
                marketItem.conditionId, 
                targetTokenId, 
                dynamicBetAmount, 
                livePrice, 
                marketItem.tickSize || "0.01"
            );

            if (result?.success) {
                pendingOrdersCache.add(targetTokenId);
                setTimeout(() => pendingOrdersCache.delete(targetTokenId), 60000); 
                
                botStatus.positionEngines[targetTokenId] = finalAnalysis.engine || "IA";
                saveConfigToDisk("Disparo Sniper IA");
                
                await sendSniperAlert({
                    marketName: `${marketTitle} (Apuesta al ${targetSideLabel})`, 
                    probability: targetProb, 
                    marketPrice: livePrice,
                    edge: edge,
                    suggestedInversion: dynamicBetAmount, 
                    reasoning: finalAnalysis.reason,
                    engine: finalAnalysis.engine || "IA"
                });

                botStatus.lastTrades[targetTokenId] = Date.now();
            }
        }

        // ====================== ACTUALIZAR DASHBOARD ======================
        const signalIndex = botStatus.pendingSignals.findIndex(s => s.tokenId === targetTokenId);

        const signalData = {
            id: Date.now(),
            marketName: marketTitle,
            tokenId: targetTokenId,
            conditionId: marketItem.conditionId,
            probability: targetProb || 0,
            reasoning: finalAnalysis.reason || "Evaluado por IA",
            marketPrice: livePrice,
            suggestedInversion: profile.microBetAmount || 2.0, 
            edge: edge,
            urgency: finalAnalysis.urgency || 5,
            recommendation: finalAnalysis.recommendation || "WAIT",
            category: marketItem.category,
            side: targetSideLabel,
            profile: profileType,
            engine: finalAnalysis.engine
        };

        if (signalIndex === -1) {
            botStatus.pendingSignals.unshift(signalData);
            if (botStatus.pendingSignals.length > 12) botStatus.pendingSignals.pop();
        } else {
            botStatus.pendingSignals[signalIndex] = { ...botStatus.pendingSignals[signalIndex], ...signalData };
        }

        watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;

    } catch (error) {
        console.error('❌ Error en runBot:', error.message);
    }
}

// ==========================================
// AUTO SELL MANAGER - VERSIÓN FINAL QUANT (Matemática Pura y Blindada)
// ==========================================
async function autoSellManager() {
    if (!botStatus.autoTradeEnabled) return;

    // Iteramos en reversa para poder borrar elementos del array sin romper el loop
    for (let i = botStatus.activePositions.length - 1; i >= 0; i--) {
        const pos = botStatus.activePositions[i];
        
        if (pos.status && pos.status.includes('CANJEAR')) continue;

        const marketNameShort = (pos.marketName || "Mercado desconocido").substring(0, 45);
        
        // 🔥 FIX QUANT CRÍTICO 1: Matemática Pura Inmune a APIs y Ventas Parciales
        const currentSharePrice = pos.exactSize > 0 ? (parseFloat(pos.currentValue) / parseFloat(pos.exactSize)) : 0;
        const entryPrice = parseFloat(pos.priceEntry || 0);
        
        // Calculamos el % de PnL nosotros mismos (Ej: de $0.50 a $0.75 = +50.0%)
        const profit = (entryPrice > 0 && currentSharePrice > 0) 
            ? ((currentSharePrice - entryPrice) / entryPrice) * 100 
            : 0;

        const isMaxPriceReached = currentSharePrice >= 0.95;

        // 🌊⏳ Detección de 5 Orígenes (Pentagrama Quant)
        let originTag = 'IA';
        let isWhaleTrade = false;

        if (pos.engine === "EQUALIZER") {
            originTag = 'EQUALIZER';
        } else if (pos.engine === "CHRONOS") {
            originTag = 'CHRONOS';
        } else if (pos.engine === "KINETIC") {
            originTag = 'KINETIC';
        } else {
            isWhaleTrade = botStatus.copiedPositions?.some(cp => cp.tokenId === pos.tokenId) || 
                           botStatus.copiedTrades?.some(ct => ct.tokenId === pos.tokenId);
            if (isWhaleTrade) originTag = 'WHALE';
        }

        const { config: riskConfig, profileType } = getRiskProfile(pos.marketName, isWhaleTrade);

        if (profit >= (riskConfig.takeProfitThreshold - 5) || profit <= (riskConfig.stopLossThreshold + 5) || currentSharePrice >= 0.90) {
            console.log(`📊 [AUTO-SELL] ${originTag}-${profileType} | ${marketNameShort} | PnL Real: ${profit.toFixed(1)}% | Precio Acc: $${currentSharePrice.toFixed(2)}`);
        }

        if (!botStatus.partialSells) botStatus.partialSells = [];
        const hasDonePartial = botStatus.partialSells.includes(pos.tokenId);

        // ====================== 🌓 TAKE PROFIT PARCIAL (HOUSE MONEY) ======================
        if (isWhaleTrade && profit >= 45 && !hasDonePartial) {
            console.log(`🌓 [TP PARCIAL] ${originTag}-${profileType} | ${marketNameShort} superó +45%. Asegurando 50% del capital...`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { httpsAgent: agent, timeout: 6500 });
                const bids = bookResp.data?.bids || [];
                
                if (bids.length > 0) {
                    const bestPrice = parseFloat(bids[0].price);
                    const spreadDropPct = currentSharePrice > 0 ? ((currentSharePrice - bestPrice) / currentSharePrice) * 100 : 0;
                    
                    if (spreadDropPct <= 35 && bestPrice > 0.005) {
                        const halfShares = parseFloat(pos.exactSize || pos.size || 0) / 2;
                        const result = await executeSellOnChain(pos.conditionId || null, pos.tokenId, halfShares, bestPrice, "0.01");
                        
                        if (result?.success) {
                            botStatus.partialSells.push(pos.tokenId);
                            saveConfigToDisk("Take Profit Parcial Ejecutado");
                            await updateRealBalances();
                            await sendAlert(`🌓 *TAKE PROFIT PARCIAL (50%)*\nOrigen: ${originTag} ${profileType}\n\n📈 Mercado: *${marketNameShort}*\n🎯 PnL: *+${profit.toFixed(1)}%*\n🛡️ Asegurado 50%, el resto corre gratis.`);
                        }
                    } else {
                        console.log(`⚠️ [ALERTA LIQUIDEZ TP PARCIAL] Abortando. Valor teórico: $${currentSharePrice.toFixed(2)}, ofrecen $${bestPrice.toFixed(2)}.`);
                    }
                }
            } catch (e) {
                console.error(`❌ Error TP Parcial:`, e.message);
            }
            continue; 
        }

        // ====================== 🌕 TAKE PROFIT TOTAL ======================
        let effectiveTpThreshold = riskConfig.takeProfitThreshold;
        if (originTag === "EQUALIZER") effectiveTpThreshold = 15; 
        else if (originTag === "CHRONOS") effectiveTpThreshold = 20; 
        else if (originTag === "KINETIC") effectiveTpThreshold = 10; 
        else if (isWhaleTrade && hasDonePartial) effectiveTpThreshold = 80;

        if (profit >= effectiveTpThreshold || isMaxPriceReached) {
            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { httpsAgent: agent, timeout: 6500 });
                const bids = bookResp.data?.bids || [];
                
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                const bestPrice = parseFloat(bids[0].price);
                const spreadDropPct = currentSharePrice > 0 ? ((currentSharePrice - bestPrice) / currentSharePrice) * 100 : 0;
                
                if (spreadDropPct > 35) {
                    console.log(`⚠️ [ALERTA LIQUIDEZ TP] Abortando TP en ${marketNameShort}. Teórico: $${currentSharePrice.toFixed(2)}, Ofrecen: $${bestPrice.toFixed(2)}`);
                    continue; 
                }

                if (bestPrice <= 0.005) continue;

                const result = await executeSellOnChain(pos.conditionId || null, pos.tokenId, sharesToSell, bestPrice, "0.01");

                if (result?.success) {
                    console.log(`📈 TP EJECUTADO [${originTag}]: ${marketNameShort} (+${profit.toFixed(1)}%)`);
                    closedPositionsCache.add(pos.tokenId);
                    delete botStatus.positionEngines[pos.tokenId]; 
                    
                    // Stats Protection
                    if (originTag !== "EQUALIZER" && originTag !== "CHRONOS" && originTag !== "KINETIC") { 
                        if (!botStatus.whaleStats) botStatus.whaleStats = { wins: 0, losses: 0, totalTrades: 0, winRate: 0 };
                        if (!botStatus.aiStats) botStatus.aiStats = { wins: 0, losses: 0, totalTrades: 0, winRate: 0 };
                        const targetStats = isWhaleTrade ? botStatus.whaleStats : botStatus.aiStats;
                        targetStats.wins += 1;
                        targetStats.totalTrades += 1;
                        targetStats.winRate = (targetStats.wins / targetStats.totalTrades) * 100;
                    }
                    saveConfigToDisk(`TP ${originTag} Ejecutado`);
                    await updateRealBalances();

                    const pnlText = `+${profit.toFixed(2)}%`;
                    let mensajeTelegram = `📈 *TAKE PROFIT (${originTag})*\n🎯 ${marketNameShort}\n📊 🟢 GANANCIA: ${pnlText}`;
                    if (originTag === "KINETIC") mensajeTelegram += `\n🏄‍♂️ Muro de liquidez surfeado con éxito.`;
                    
                    await sendAlert(mensajeTelegram);

                    if (isWhaleTrade) {
                        botStatus.copiedPositions = botStatus.copiedPositions.filter(p => p.tokenId !== pos.tokenId);
                    }
                    botStatus.activePositions.splice(i, 1); 
                }
            } catch (e) {
                console.error(`❌ Take Profit error:`, e.message);
            }
            continue;
        }

        // ====================== 🛑 STOP LOSS ======================
        if (profit <= riskConfig.stopLossThreshold) {
            const isLotteryTicket = currentSharePrice <= 0.03; 
            const totalValueLeft = parseFloat(pos.currentValue || 0);
            const isWorthRescuing = totalValueLeft >= 0.50;    

            if (isLotteryTicket || !isWorthRescuing) {
                if (profit <= (riskConfig.stopLossThreshold - 10)) { 
                    console.log(`🎫 [MOONSHOT] ${marketNameShort} tocó SL pero vale migajas ($${currentSharePrice.toFixed(2)}). Se deja a expiración.`);
                }
                continue; 
            }

            console.log(`🛑 STOP LOSS DETECTADO [${originTag}]: ${marketNameShort} (${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { httpsAgent: agent, timeout: 6500 });
                const bids = bookResp.data?.bids || [];
                
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                let bestBidPrice = parseFloat(bids[0].price);

                const spreadDropPct = currentSharePrice > 0 ? ((currentSharePrice - bestBidPrice) / currentSharePrice) * 100 : 0;
                if (spreadDropPct > 35) {
                    console.log(`⚠️ [ALERTA LIQUIDEZ] Abortando SL en ${marketNameShort}. Valor teórico: $${currentSharePrice.toFixed(2)}, Ofrecen: $${bestBidPrice.toFixed(2)}.`);
                    continue; 
                }

                if (bestBidPrice <= 0.001) bestBidPrice = 0.001;

                let worstPrice = bestBidPrice;
                let accumulated = 0;
                for (const bid of bids) {
                    accumulated += parseFloat(bid.size || 0);
                    worstPrice = parseFloat(bid.price);
                    if (accumulated >= sharesToSell) break;
                }

                const maxPanicSlippage = botStatus.riskSettings?.panicSlippage || 40;
                if ((((bestBidPrice - worstPrice) / bestBidPrice) * 100) > maxPanicSlippage) {
                    worstPrice = bestBidPrice * (1 - (maxPanicSlippage / 100));
                }

                const result = await executeSellOnChain(pos.conditionId || null, pos.tokenId, sharesToSell, worstPrice, "0.01");

                if (result?.success) {
                    closedPositionsCache.add(pos.tokenId);
                    delete botStatus.positionEngines[pos.tokenId]; 

                    if (originTag !== "EQUALIZER" && originTag !== "CHRONOS" && originTag !== "KINETIC") {
                        if (!botStatus.whaleStats) botStatus.whaleStats = { wins: 0, losses: 0, totalTrades: 0, winRate: 0 };
                        if (!botStatus.aiStats) botStatus.aiStats = { wins: 0, losses: 0, totalTrades: 0, winRate: 0 };
                        const targetStats = isWhaleTrade ? botStatus.whaleStats : botStatus.aiStats;
                        targetStats.losses += 1;
                        targetStats.totalTrades += 1;
                        targetStats.winRate = (targetStats.wins / targetStats.totalTrades) * 100;
                    }
                    saveConfigToDisk(`SL ${originTag} Ejecutado`);
                    await updateRealBalances();

                    const pnlText = `${profit.toFixed(2)}%`;
                    let mensajeTelegram = `🛑 *STOP LOSS (${originTag})*\n🎯 ${marketNameShort}\n📊 🔴 PÉRDIDA: ${pnlText}\n💸 Rescatado: $${(sharesToSell*worstPrice).toFixed(2)}`;
                    await sendAlert(mensajeTelegram);

                    if (isWhaleTrade) {
                        botStatus.copiedPositions = botStatus.copiedPositions.filter(p => p.tokenId !== pos.tokenId);
                    }
                    botStatus.activePositions.splice(i, 1); 
                }
            } catch (e) {
                console.error(`❌ Stop Loss error:`, e.message);
            }
        }
    }
}


// ==========================================
// AUTO REDEEM POSITIONS - Versión que canjea TODO (ganadoras y perdedoras)
// ==========================================
async function autoRedeemPositions() {
    let redeemedCount = 0;

    try {
        console.log("🔄 [AUTO-REDEEM] Revisando posiciones marcadas para canjear...");

        const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
        const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

        const signer = clobClient.signer || (clobClient.wallet ? clobClient.wallet : null);

        if (!signer) {
            console.error("❌ No se encontró signer para realizar el redeem");
            return 0;
        }

        const ctfInterface = new ethers.utils.Interface([
            "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)"
        ]);

        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice 
            ? feeData.gasPrice.mul(130).div(100) 
            : ethers.utils.parseUnits("60", "gwei");

        for (const pos of [...botStatus.activePositions]) {
            const statusLower = (pos.status || "").toLowerCase();
            if (!statusLower.includes("canjear")) continue;

            if (!pos.conditionId) continue;

            try {
                const txData = ctfInterface.encodeFunctionData("redeemPositions", [
                    USDC_ADDRESS,
                    ethers.constants.HashZero,
                    pos.conditionId,
                    [1, 2]
                ]);

                const tx = await signer.sendTransaction({
                    to: CTF_ADDRESS,
                    data: txData,
                    gasLimit: 400000,
                    gasPrice: gasPrice
                });

                await tx.wait(1);

                console.log(`✅ [REDEEM] Canjeado: ${pos.marketName?.substring(0, 50)}...`);

                // Marcamos como canjeado (aunque ya no aparecerá en el próximo refresh)
                pos.status = "CANJEADO ✅";
                redeemedCount++;

                await sendAlert(`🔄 *REDEEM EXITOSO*\nMercado: ${pos.marketName?.substring(0, 45)}...\nCanjeado automáticamente`);

            } catch (err) {
                const msg = err.message.toLowerCase();
                if (!msg.includes("not resolved") && !msg.includes("already redeemed")) {
                    console.error(`❌ Redeem falló en ${pos.marketName?.substring(0, 40)}:`, err.message);
                }
            }
        }

        if (redeemedCount > 0) {
            await updateRealBalances();
            saveConfigToDisk("Auto Redeem ejecutado");
            console.log(`🎉 [AUTO-REDEEM] ${redeemedCount} posiciones canjeadas`);
        } else {
            console.log("ℹ️ [AUTO-REDEEM] No había posiciones listas para canjear");
        }

        return redeemedCount;

    } catch (err) {
        console.error("❌ Error general en autoRedeemPositions:", err.message);
        return 0;
    }
}

// ==========================================
// AUTO REDEEM GASLESS - Versión ultra-estable (sin constructor problemático)
// ==========================================
async function autoRedeemPositionsGasless() {
    let redeemedCount = 0;

    try {
        console.log("🔄 [AUTO-REDEEM GASLESS] Iniciando canje sin pagar gas...");

        const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');

        if (!process.env.POLY_API_KEY || !process.env.POLY_SECRET || !process.env.POLY_PASSPHRASE) {
            console.error("❌ Faltan credenciales del Builder Relayer en .env");
            return 0;
        }

        // Configuración mínima y estable (evita constructores problemáticos)
        const relayerClient = new RelayClient({
            url: "https://relayer-v2.polymarket.com",
            chainId: 137,
            privateKey: process.env.POLY_PRIVATE_KEY || "",
            builderKey: process.env.POLY_API_KEY,
            builderSecret: process.env.POLY_SECRET,
            builderPassphrase: process.env.POLY_PASSPHRASE,
            relayTxType: RelayerTxType.SAFE
        });

        const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
        const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

        for (const pos of [...botStatus.activePositions]) {
            const statusLower = (pos.status || "").toLowerCase();
            if (!statusLower.includes("canjear")) continue;

            if (!pos.conditionId) continue;

            try {
                const redeemTx = {
                    to: CTF_ADDRESS,
                    data: ethers.utils.defaultAbiCoder.encode(
                        ["address", "bytes32", "bytes32", "uint256[]"],
                        [
                            USDC_ADDRESS,
                            ethers.constants.HashZero,
                            pos.conditionId,
                            [1, 2]
                        ]
                    ),
                    value: "0"
                };

                const response = await relayerClient.execute([redeemTx], `Redeem ${pos.marketName?.substring(0, 30) || 'Position'}`);
                await response.wait();

                console.log(`✅ [REDEEM GASLESS] Canjeado: ${pos.marketName?.substring(0, 45)}...`);

                pos.status = "CANJEADO ✅";
                redeemedCount++;

                await sendAlert(`🔄 *REDEEM GASLESS EXITOSO*\nMercado: ${pos.marketName?.substring(0, 45)}...\nCanjeado sin pagar gas`);

            } catch (err) {
                const msg = err.message.toLowerCase();
                if (!msg.includes("not resolved") && !msg.includes("already redeemed")) {
                    console.error(`❌ Gasless redeem falló en ${pos.marketName?.substring(0, 40)}:`, err.message);
                }
            }
        }

        if (redeemedCount > 0) {
            await updateRealBalances();
            saveConfigToDisk("Auto Redeem Gasless ejecutado");
            console.log(`🎉 [AUTO-REDEEM GASLESS] ${redeemedCount} posiciones canjeadas sin gas`);
        } else {
            console.log("ℹ️ [AUTO-REDEEM GASLESS] No había posiciones listas para canjear");
        }

        return redeemedCount;

    } catch (err) {
        console.error("❌ Error general en autoRedeemPositionsGasless:", err.message);
        return 0;
    }
}
// ==========================================
// 🚨 VIGILANTE DE PORTAFOLIO (PNL MONITOR)
// ==========================================
async function monitorPortfolio() {
    try {
        console.log("🕵️‍♂️ Revisando PnL del portafolio...");
        
        // Primero nos aseguramos de tener los saldos más frescos
        await updateRealBalances();
        // Quitar trades huérfanos (que ya no están activos)
        await cleanupCopiedState();

        if (!botStatus.activePositions || botStatus.activePositions.length === 0) {
            profitAlertCache.clear(); // Si no hay posiciones, limpiamos la memoria
            return;
        }

        let posicionesGanadoras = [];
        let totalPnl = 0;
        
        // Mapeamos los IDs de las posiciones actuales para limpiar el caché de las que ya se vendieron
        const currentTokenIds = botStatus.activePositions.map(p => p.tokenId);
        for (const id of profitAlertCache) {
            if (!currentTokenIds.includes(id)) profitAlertCache.delete(id);
        }

        for (const pos of botStatus.activePositions) {
            // Solo evaluamos los que están vivos
            if (pos.status.includes('ACTIVO')) {
                totalPnl += (pos.cashPnl || 0);
                
                // 🔥 LA REGLA DE ORO: Si la ganancia supera el 5% y NO hemos avisado antes
                if (pos.percentPnl && pos.percentPnl >= 5.0) {
                    
                    if (!profitAlertCache.has(pos.tokenId)) {
                        posicionesGanadoras.push(
                            `📈 *${pos.marketName.substring(0,35)}...*\n` +
                            `Valor Actual: *$${pos.currentValue} USDC*\n` +
                            `Ganancia: *+$${pos.cashPnl.toFixed(2)} (+${pos.percentPnl.toFixed(1)}%)*\n` +
                            `⏳ _Esperando llegar al Auto-Sell (15%)_`
                        );
                        // Lo guardamos en memoria para no volver a hacer spam
                        profitAlertCache.add(pos.tokenId);
                    }
                }
            }
        }

        // Si encontró NUEVAS posiciones jugosas, dispara el mensaje a Telegram
        // if (posicionesGanadoras.length > 0) {
        //     const alerta = `🚨 *ALERTA DE TOMA DE GANANCIAS* 🚨\nNuevas posiciones cruzaron el 5% de ganancia:\n\n${posicionesGanadoras.join('\n\n')}\n\n💵 *PnL Global Flotante: $${totalPnl.toFixed(2)}*`;
        //     await sendAlert(alerta);
        // }

    } catch (error) {
        console.error("❌ Error en monitorPortfolio:", error.message);
    }
}

// ==========================================
// DAILY LOSS LIMIT (Stop-loss global del día)
// ==========================================
async function checkDailyLossLimit() {
    // Solo activamos si hay algún tipo de Copy Trading o AutoTrade
    if (!botStatus.copyTradingCustomEnabled && 
        !botStatus.copyTradingAutoEnabled && 
        !botStatus.autoTradeEnabled) return;

    try {
        let activePortfolioValue = 0;
        if (botStatus.activePositions && botStatus.activePositions.length > 0) {
            activePortfolioValue = botStatus.activePositions.reduce((acc, pos) => {
                return !pos.status.includes('CANJEAR') ? acc + parseFloat(pos.currentValue || 0) : acc;
            }, 0);
        }

        const totalCurrentValue = parseFloat(botStatus.clobOnlyUSDC || 0) + activePortfolioValue;

        if (botStatus.dailyStartBalance === 0) {
            botStatus.dailyStartBalance = totalCurrentValue;
        }

        const dailyPnL = totalCurrentValue - botStatus.dailyStartBalance;
        botStatus.dailyPnL = dailyPnL;

        const lossPercent = botStatus.dailyStartBalance > 0 
            ? (dailyPnL / botStatus.dailyStartBalance) * 100 
            : 0;

        if (lossPercent <= -botStatus.dailyLossLimit && !botStatus.isPanicStopped) {
            console.log(`🚨 [DAILY LIMIT] Stop-loss diario activado (${lossPercent.toFixed(1)}%). Deteniendo bot...`);
            botStatus.isPanicStopped = true;
            await sendAlert(`🚨 *STOP-LOSS DIARIO ACTIVADO*\nPérdida del día real: ${lossPercent.toFixed(1)}%\nBot bloqueó nuevas compras.`);
        }
    } catch (e) {
        console.error("Error en checkDailyLossLimit:", e.message);
    }
}

// ==========================================
// 🤖 AUTO-SELECTOR DE MODELO GEMINI
// ==========================================
async function initGemini() {
    try {
        console.log("🔍 [GEMINI] Buscando el modelo estable más rápido en la nube...");
        const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
        
        const response = await axios.get(url);
        const models = response.data.models;

        let selectedModelName = null;

        for (const model of models) {
            const shortName = model.name.replace('models/', '');
            
            // 🔥 MAGIA QUANT: Expresión regular que busca estrictamente "gemini-X.X-flash"
            // (Ignorará automáticamente versiones 'pro', 'preview' o 'lite')
            if (/^gemini-\d+\.\d+-flash$/.test(shortName)) {
                selectedModelName = shortName;
                break; // Tomamos el primero de la lista (Google siempre pone el más nuevo arriba)
            }
            
            // Fallback en caso de que Google cambie la convención de nombres
            if (shortName === 'gemini-flash-latest' && !selectedModelName) {
                selectedModelName = shortName;
            }
        }

        // Fallback duro por seguridad extrema
        if (!selectedModelName) {
            selectedModelName = 'gemini-2.5-flash'; 
        }

        console.log(`✅ [GEMINI] Modelo inicializado exitosamente: ${selectedModelName}`);

        // Inyectamos el modelo seleccionado a la variable global de nuestro bot
        geminiModel = genAI.getGenerativeModel({ 
            model: selectedModelName,
            generationConfig: {
                responseMimeType: "application/json"
            }
        });

    } catch (error) {
        console.error("❌ [GEMINI] Error en auto-selección, forzando gemini-2.5-flash:", error.message);
        geminiModel = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            generationConfig: {
                responseMimeType: "application/json"
            }
        });
    }
}

// ==========================================
// 🛡️ GUARDIÁN DE SALUD DEL SERVIDOR (AUTO-HEALING)
// ==========================================
let lastHealthAlertTime = 0; 

async function monitorSystemHealth() {
    try {
        const now = Date.now();
        const botRamMB = process.memoryUsage().rss / 1024 / 1024;
        const cpuLoad = os.loadavg()[0];

        // Umbrales de Peligro
        const RAM_LIMIT = 700; // Alerta y reinicio si pasa de 700 MB
        const CPU_LIMIT = 1.5; // Alerta si la carga promedio pasa de 1.5

        let alertMsg = "";
        let shouldAutoRestart = false;

        // 1. Verificación de RAM (Disparador de Auto-Healing)
        if (botRamMB > RAM_LIMIT) {
            alertMsg += `⚠️ *Fuga de Memoria Detectada*\nEl Poly-Bot está consumiendo \`${botRamMB.toFixed(0)} MB\` de RAM.\n\n`;
            shouldAutoRestart = true; 
        }

        // 2. Verificación de CPU (Solo Alerta)
        if (cpuLoad > CPU_LIMIT) {
            alertMsg += `🔥 *Sobrecarga de Procesador*\nEl CPU de Toronto está al \`${cpuLoad.toFixed(2)}\` (Riesgo de Lag).\n\n`;
        }

        // 3. Ejecución de Acciones
        if (alertMsg !== "") {
            // Evitamos saturar Telegram si no es un reinicio inminente
            if (now - lastHealthAlertTime < 3600000 && !shouldAutoRestart) return;

            const actionText = shouldAutoRestart 
                ? `*Acción:* Ejecutando Auto-Reinicio (Auto-Healing) ahora mismo 🔄` 
                : `*Acción recomendada:* Monitorear o reiniciar manualmente si persiste.`;

            await sendAlert(
                `🚨 *ALERTA DE INFRAESTRUCTURA* 🚨\n\n` + 
                `${alertMsg}` +
                `${actionText}`
            );

            lastHealthAlertTime = now;
            console.log(shouldAutoRestart ? "🔄 [SISTEMA] Iniciando Auto-Healing..." : "🚨 [SISTEMA] Alerta de salud enviada.");

            // 🔥 EL CORAZÓN DEL AUTO-HEALING
            if (shouldAutoRestart) {
                // Esperamos 3 segundos para asegurar que el mensaje de Telegram se envíe correctamente
                setTimeout(() => {
                    console.log("💀 Matando proceso para reinicio limpio por PM2...");
                    process.exit(1); 
                }, 3000);
            }
        }
    } catch (error) {
        console.error("❌ Error en monitorSystemHealth:", error.message);
    }
}

// ==========================================
// CLEANUP DE COPIED TRADES - Elimina trades cerrados
// ==========================================
async function cleanupCopiedTrades() {
    if (!botStatus.copiedTrades || botStatus.copiedTrades.length === 0) return;

    const activeTokenIds = new Set(
        botStatus.activePositions.map(p => p.tokenId)
    );

    const before = botStatus.copiedTrades.length;

    botStatus.copiedTrades = botStatus.copiedTrades.filter(trade => 
        activeTokenIds.has(trade.tokenId)
    );

    const removed = before - botStatus.copiedTrades.length;

    if (removed > 0) {
        console.log(`🧹 [CLEANUP] Eliminados ${removed} trades cerrados de copiedTrades`);
        saveConfigToDisk("Cleanup de copiedTrades");
    }
}

// ==========================================
// 🧠 MOTOR DE MEMORIA: REGISTRO DE PRECIOS
// ==========================================
function recordPriceToMemory(tokenId, currentPrice) {
    if (!botStatus.equalizerEnabled) return; // Si está apagado, ahorramos RAM

    const now = Date.now();
    
    // 1. Inicializar la matriz del mercado si no existe
    if (!priceHistoryCache[tokenId]) {
        priceHistoryCache[tokenId] = [];
    }

    // 2. Inyectar el precio actual en la línea de tiempo
    priceHistoryCache[tokenId].push({ 
        timestamp: now, 
        price: parseFloat(currentPrice) 
    });

    // 3. Limpieza Quant (Garbage Collection)
    // Destruimos cualquier registro que tenga más de 10 minutos de antigüedad (600,000 ms).
    // Solo nos interesa el pasado reciente para cazar el Pánico.
    priceHistoryCache[tokenId] = priceHistoryCache[tokenId].filter(
        entry => (now - entry.timestamp) <= 10 * 60 * 1000
    );
}

// ==========================================
// 🤖 IA FLASH CHECK Y ESCUDO DE LATENCIA (BLINDADO VECTORIAL 3 CAPAS)
// ==========================================
async function verifyShockWithIA(marketData, eventProbabilityChange, triggerPrice, shockTokenId, outcomeToBuy) {
    const direction = eventProbabilityChange > 0 ? "AUMENTADO" : "CAÍDO";
    const newsString = await getLatestNews(marketData.title, marketData.category); 
    
    const flashPrompt = `
        [ALERTA DE SHOCK DE LIQUIDEZ]: La probabilidad de que ocurra el evento "${marketData.title}" ha ${direction} bruscamente un ${Math.abs(eventProbabilityChange).toFixed(1)}% en 5 minutos.
        Noticias recientes: "${newsString || 'Ninguna noticia relevante'}".
        INSTRUCCIÓN VITAL: Si este salto brusco de probabilidad NO tiene sentido y es puro pánico humano/error de dedo en el mercado, tu "recommendation" debe ser "WAIT" y tu "reason" debe decir "Pánico irracional". Si el cambio SÍ está justificado por las noticias reales, tu "recommendation" debe ser "BUY".
    `;

    try {
        console.log(`🧠 [EQUALIZER] Consultando a Claude (Vía Rápida)...`);
        let result;
        const claudeResponse = await analyzeMarketWithClaude(marketData.title, flashPrompt, 1);
        
        if (!claudeResponse.isError) {
             result = { isJustified: claudeResponse.recommendation !== "WAIT", reason: claudeResponse.reason, confidence: (claudeResponse.prob * 100) || 80 };
        } else {
             console.log(`⚠️ [EQUALIZER] Claude falló. Lanzando a Gemini...`);
             const geminiResponse = await analyzeMarketWithGemini(marketData.title, flashPrompt, 1);
             
             if (!geminiResponse.isError) {
                 result = { isJustified: geminiResponse.recommendation !== "WAIT", reason: geminiResponse.reason, confidence: (geminiResponse.prob * 100) || 80 };
             } else {
                 console.log(`⚠️ [EQUALIZER] Gemini falló. Lanzando a Grok...`);
                 const grokResponse = await analyzeMarketWithGrok(marketData.title, flashPrompt, 1);
                 
                 if (!grokResponse.isError) {
                     result = { isJustified: grokResponse.recommendation !== "WAIT", reason: grokResponse.reason, confidence: (grokResponse.prob * 100) || 80 };
                 } else {
                     console.log(`❌ [EQUALIZER ABORTADO] Las 3 APIs están caídas. No disparamos a ciegas.`);
                     delete priceHistoryCache[shockTokenId];
                     return; 
                 }
             }
        }

        if (result.isJustified === false && result.confidence >= 75) {
            console.log(`📉 [EQUALIZER] IA Confirma Pánico Humano (Confianza: ${result.confidence.toFixed(0)}%). Razón: ${result.reason}`);
            
            const currentLivePrice = await getMarketPrice(shockTokenId) || (outcomeToBuy === "YES" ? marketData.priceYes : marketData.priceNo);
            // 🔥 FIX QUANT: La fórmula de descuento ahora es correcta para ambos lados
            const expectedDiscountPrice = outcomeToBuy === "YES" ? triggerPrice : (1 - triggerPrice);
            
            if (parseFloat(currentLivePrice) > expectedDiscountPrice + 0.03) {
                console.log(`⚠️ [EQUALIZER ABORTADO] El mercado ya se corrigió. Esperado: $${expectedDiscountPrice.toFixed(2)}, Actual: $${currentLivePrice}.`);
                delete priceHistoryCache[shockTokenId];
                return;
            }

            await executeEqualizerTrade(marketData, outcomeToBuy);
            delete priceHistoryCache[shockTokenId];
        } else {
            console.log(`⏩ [EQUALIZER IGNORADO] Movimiento justificado por noticias reales. Razón: ${result.reason}`);
            delete priceHistoryCache[shockTokenId]; 
        }
    } catch (err) {
        console.error("❌ Error en IA Equalizer:", err.message);
        delete priceHistoryCache[shockTokenId]; 
    }
}

// ==========================================
// 🔫 EL GATILLO: EJECUCIÓN DEL QUANTUM EQUALIZER
// ==========================================
async function executeEqualizerTrade(marketData, outcomeToBuy) {
    try {
        // 🛡️ CANDADO 1: Freno de Emergencia Global
        if (botStatus.isPanicStopped) {
            console.log("🚨 [EQUALIZER] Modo Pánico activo. Disparo abortado.");
            return;
        }

        // Buscamos el mercado completo en la watchlist
        const fullMarket = botStatus.watchlist.find(m => m.title === marketData.marketName);
        if (!fullMarket) return;

        const targetTokenId = outcomeToBuy === "YES" ? fullMarket.tokenYes : fullMarket.tokenNo;
        
        // 🛡️ CANDADO 2: Filtro Anti-Duplicados
        const alreadyInvested = botStatus.activePositions.some(pos => pos.tokenId === targetTokenId);
        const alreadyPending = pendingOrdersCache.has(targetTokenId);
        if (alreadyInvested || alreadyPending) {
            console.log(`⏩ [EQUALIZER] Ya tenemos posición abierta en este Shock. Omitiendo.`);
            return;
        }

        const targetPrice = outcomeToBuy === "YES" ? fullMarket.priceYes : fullMarket.priceNo;
        
        const betAmount = botStatus.equalizerBetAmount || 5;
        const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);

        // 🛡️ CANDADO 3: Liquidez Básica
        if (saldoLibre < betAmount) {
            console.log(`⚠️ [EQUALIZER] Saldo insuficiente ($${saldoLibre.toFixed(2)}). Disparo abortado.`);
            return;
        }

        console.log(`⚡ [EQUALIZER DISPARO] Aprovechando el Pánico en ${marketData.marketName}`);
        console.log(`🎯 Comprando ${outcomeToBuy} a $${targetPrice} | Inversión: $${betAmount} USDC`);

        const result = await executeTradeOnChain(
            fullMarket.conditionId,
            targetTokenId,
            betAmount,
            targetPrice,
            fullMarket.tickSize || "0.01"
        );

        if (result?.success) {
            pendingOrdersCache.add(targetTokenId);
            setTimeout(() => pendingOrdersCache.delete(targetTokenId), 60000); // 🔥 FIX VITAL: Limpieza Cuántica olvidada

            botStatus.lastTrades[targetTokenId] = Date.now();
            botStatus.positionEngines[targetTokenId] = "EQUALIZER"; // <-- TATUAJE DE MEMORIA
            
            // 🎨 INYECCIÓN PARA EL FRONTEND (La Mejor Práctica)
            // Lo metemos al arreglo general, pero lo "tatuamos" como EQUALIZER
            botStatus.activePositions.push({
                tokenId: targetTokenId,
                conditionId: fullMarket.conditionId,
                marketName: fullMarket.title,
                sizeCopied: betAmount,        
                exactSize: betAmount / targetPrice, 
                priceEntry: targetPrice,
                outcome: outcomeToBuy,
                category: fullMarket.category || "MEAN_REVERSION",
                status: "ACTIVO 🟢",
                engine: "EQUALIZER" // <-- ESTA ES LA ETIQUETA MÁGICA
            });

            saveConfigToDisk("Disparo Quantum Equalizer");
            
            // 📱 ALERTA DE TELEGRAM CUSTOMIZADA
            if (typeof sendSniperAlert === "function") {
                await sendSniperAlert({
                    marketName: `🌊 [SHOCK ABSORBER] ${fullMarket.title} (Compra: ${outcomeToBuy})`, 
                    probability: outcomeToBuy === "YES" ? 0.99 : 0.01, 
                    marketPrice: targetPrice,
                    edge: botStatus.equalizerShockThreshold / 100, // Edge = tamaño del shock
                    suggestedInversion: betAmount, 
                    reasoning: "⚡ Shock de liquidez detectado. Pánico irracional confirmado por IA. Extrayendo ganancia...",
                    engine: "Quantum Equalizer"
                });
            }
        }
    } catch (error) {
        console.error(`❌ [EQUALIZER ERROR] Fallo al ejecutar: ${error.message}`);
    }
}

// ==========================================
// 🧠 RADAR DE ALTA FRECUENCIA (Alimenta Equalizer y Chronos)
// ==========================================
async function updateHighFrequencyRadar() {
    // Si ambos están apagados, ahorramos recursos
    if (!botStatus.equalizerEnabled && !botStatus.chronosEnabled) return;
    
    try {
        // 1. Descargamos los precios frescos
        await refreshWatchlist(); 
        
        // 2. Solo alimentamos la RAM del historial si el Equalizer está encendido
        if (botStatus.equalizerEnabled) {
            botStatus.watchlist.forEach(market => {
                if (market.priceYes) recordPriceToMemory(market.tokenYes, market.priceYes);
                if (market.priceNo) recordPriceToMemory(market.tokenNo, market.priceNo);
            });
        }
    } catch (error) {
        console.error("❌ Error alimentando radar HFT:", error.message);
    }
}

// ==========================================
// ⏳ CHRONOS HARVESTER (THETA DECAY ENGINE)
// ==========================================
async function runChronosHarvester() {
    if (!botStatus.chronosEnabled || botStatus.isPanicStopped) return;

    console.log(`⏳ [CHRONOS] Escaneando Watchlist en busca de Theta Decay...`);

    const now = Date.now();

    for (const market of botStatus.watchlist) {
        if (!market.endDate || !market.priceNo || !market.tokenNo) continue;

        const endTime = new Date(market.endDate).getTime();
        const hoursLeft = (endTime - now) / (1000 * 60 * 60);

        if (hoursLeft > 0 && hoursLeft <= botStatus.chronosHoursLeft && market.priceNo >= botStatus.chronosMinPrice && market.priceNo <= botStatus.chronosMaxPrice) {
            
            const alreadyInvested = botStatus.activePositions.some(p => p.tokenId === market.tokenNo);
            const alreadyPending = pendingOrdersCache.has(market.tokenNo);
            const alreadyClosed = closedPositionsCache.has(market.tokenNo);
            if (alreadyInvested || alreadyPending || alreadyClosed) continue;

            const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
            if (saldoLibre < botStatus.chronosBetAmount) continue;

            console.log(`⏳ [CHRONOS DETECTADO] ${market.title} | Precio NO: $${market.priceNo} | Expira en: ${hoursLeft.toFixed(1)}h`);

            const newsString = await getLatestNews(market.title, market.category);
            
            // 🛡️ FIX QUANT: Prompt adaptado al parser JSON nativo
            const chronosPrompt = `
                [INFO THETA DECAY]: El mercado "${market.title}" expira en solo ${hoursLeft.toFixed(1)} horas. 
                Noticias recientes: "${newsString || 'Ninguna'}".
                INSTRUCCIÓN VITAL: Si NO hay noticias fuertes que indiquen que el evento va a suceder de último minuto, tu "recommendation" debe ser "WAIT" y tu "reason" debe ser "Evento muerto por tiempo". Si hay peligro real de que suceda, pon "BUY".
            `;

            try {
                let result;
                const claudeRes = await analyzeMarketWithClaude(market.title, chronosPrompt, 1);
                
                if (!claudeRes.isError) {
                    // Si Claude dice WAIT, significa que no pasará nada (El evento está muerto, compramos el NO)
                    result = { isDead: claudeRes.recommendation === "WAIT" || claudeRes.reason.toLowerCase().includes("muerto"), reason: claudeRes.reason, confidence: (claudeRes.prob * 100) || 85 };
                } else {
                    const grokRes = await analyzeMarketWithGrok(market.title, chronosPrompt, 1);
                    if (!grokRes.isError) {
                        result = { isDead: grokRes.recommendation === "WAIT" || grokRes.reason.toLowerCase().includes("muerto"), reason: grokRes.reason, confidence: (grokRes.prob * 100) || 85 };
                    } else continue; 
                }

                if (result.isDead && result.confidence >= 75) {
                    console.log(`📉 [CHRONOS] IA Confirma Evento Muerto. Comprando el NO. Razón: ${result.reason}`);

                    const currentLivePrice = await getMarketPrice(market.tokenNo) || market.priceNo;
                    if (parseFloat(currentLivePrice) > market.priceNo + 0.03) {
                        console.log(`⚠️ [CHRONOS] El precio subió mientras la IA pensaba. Abortando.`);
                        continue;
                    }

                    const tradeResult = await executeTradeOnChain(market.conditionId, market.tokenNo, botStatus.chronosBetAmount, currentLivePrice, market.tickSize);
                    
                    if (tradeResult?.success) {
                        pendingOrdersCache.add(market.tokenNo);
                        setTimeout(() => pendingOrdersCache.delete(market.tokenNo), 60000); // Limpieza Cuántica
                        botStatus.lastTrades[market.tokenNo] = Date.now();
                        botStatus.positionEngines[market.tokenNo] = "CHRONOS"; // <-- TATUAJE DE MEMORIA
                        
                        botStatus.activePositions.push({
                            tokenId: market.tokenNo,
                            conditionId: market.conditionId,
                            marketName: market.title,
                            sizeCopied: botStatus.chronosBetAmount,        
                            exactSize: botStatus.chronosBetAmount / currentLivePrice, 
                            priceEntry: currentLivePrice,
                            outcome: "NO",
                            category: market.category || "THETA_DECAY",
                            status: "ACTIVO 🟢",
                            engine: "CHRONOS" 
                        });
                        saveConfigToDisk("Disparo Chronos");

                        // 📱 NUEVO: Alerta directa a Telegram
                        try {
                            const telegramMsg = `⏳ *NUEVA COSECHA CHRONOS*\n🎯 ${market.title}\n🛒 Compra: *NO*\n💰 Capital: $${botStatus.chronosBetAmount}\n📉 Precio: $${currentLivePrice}\n⏰ Expira en: ${hoursLeft.toFixed(1)}h\n🧹 Extrayendo valor del tiempo...`;
                            if (typeof sendAlert === "function") await sendAlert(telegramMsg);
                        } catch (e) {
                            console.error("❌ Error enviando alerta de Telegram (Chronos):", e.message);
                        }

                        if (typeof sendSniperAlert === "function") {
                            await sendSniperAlert({
                                marketName: `⏳ [CHRONOS HARVESTER] ${market.title} (Compra: NO)`, 
                                probability: result.confidence / 100, 
                                marketPrice: currentLivePrice,
                                edge: (0.99 - currentLivePrice), 
                                suggestedInversion: botStatus.chronosBetAmount, 
                                reasoning: "Expiración inminente sin catalizadores. Extrayendo valor del tiempo...",
                                engine: "Chronos"
                            });
                        }
                    }
                } else {
                    console.log(`⏩ [CHRONOS] Peligro: El evento podría ocurrir. Ignorando.`);
                }
            } catch (err) {
                console.error("❌ Error en Chronos IA:", err.message);
            }
        }
    }
}

// ==========================================
// 📈 ANALIZADOR DE SHOCKS DE LIQUIDEZ (BLINDADO QUANT)
// ==========================================
async function checkForLiquidityShocks() {
    if (!botStatus.equalizerEnabled) return;
    if (botStatus.isPanicStopped) return; 

    for (const tokenId in priceHistoryCache) {
        const history = priceHistoryCache[tokenId];
        if (history.length < 2) continue; 

        const currentEntry = history[history.length - 1];
        const oldestEntry = history[0]; 

        if (oldestEntry.price < 0.05 || oldestEntry.price > 0.85) continue;

        const priceChange = currentEntry.price - oldestEntry.price;
        const priceChangePct = (priceChange / oldestEntry.price) * 100;

        if (Math.abs(priceChangePct) >= botStatus.equalizerShockThreshold) {
            
            const fullMarket = botStatus.watchlist.find(m => m.tokenYes === tokenId || m.tokenNo === tokenId);
            if (!fullMarket) continue; 

            const isYesToken = (fullMarket.tokenYes === tokenId);
            
            // 🔥 FIX VECTORIAL: Calculamos el cambio de probabilidad real del evento
            const eventProbabilityChange = isYesToken ? priceChangePct : -priceChangePct;

            let outcomeToBuy;
            if (priceChangePct > 0) {
                outcomeToBuy = isYesToken ? "NO" : "YES"; // Si sube mucho, compramos la contraparte barata
            } else {
                outcomeToBuy = isYesToken ? "YES" : "NO"; // Si cae mucho, compramos el descuento
            }

            const targetTokenId = outcomeToBuy === "YES" ? fullMarket.tokenYes : fullMarket.tokenNo;

            const alreadyInvested = botStatus.activePositions.some(p => p.tokenId === targetTokenId);
            const alreadyPending = pendingOrdersCache.has(targetTokenId);

            if (alreadyInvested || alreadyPending) continue;

            console.log(`🚨 [SHOCK DETECTADO] ${fullMarket.title}`);
            console.log(`📊 Movimiento de ${priceChangePct > 0 ? '+' : ''}${priceChangePct.toFixed(2)}% en el token ${isYesToken ? 'YES' : 'NO'}. Verificando con IA...`);

            // Enviamos el "eventProbabilityChange" normalizado a la IA
            await verifyShockWithIA(fullMarket, eventProbabilityChange, currentEntry.price, targetTokenId, outcomeToBuy);
        }
    }
}

// ==========================================
// 11. RUTAS API DASHBOARD Y ARRANQUE (LIMPIO)
// ==========================================

// 1. Envía el estado completo, saldos e historial al Frontend (Se llama cada 2 seg)
app.get('/api/status', (req, res) => {
    // Calculamos métricas en tiempo real
    const systemMetrics = {
        // RAM exclusiva que está consumiendo tu bot (RSS)
        botRamMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
        // RAM total del servidor de Toronto
        serverTotalRamMB: (os.totalmem() / 1024 / 1024).toFixed(2),
        // RAM libre restante
        serverFreeRamMB: (os.freemem() / 1024 / 1024).toFixed(2),
        // Horas que lleva el bot sin apagarse
        uptimeHours: (process.uptime() / 3600).toFixed(2),
        // Carga promedio del CPU en el último minuto
        cpuLoad: os.loadavg()[0].toFixed(2) 
    };
    res.json({
        ...botStatus,
        systemMetrics // 🔥 Inyectamos la telemetría al JSON de respuesta
    });
});

// 🔥 ENDPOINT MAESTRO DE RIESGO BIDIMENSIONAL
app.post('/api/settings/risk', (req, res) => {
    const { source, profile, settings } = req.body;
    
    if (source === 'ai') {
        botStatus.aiConfig[profile] = { ...botStatus.aiConfig[profile], ...settings };
    } else if (source === 'whale') {
        botStatus.whaleConfig[profile] = { ...botStatus.whaleConfig[profile], ...settings };
    }
    
    saveConfigToDisk("API Riesgo");
    console.log(`⚖️ Gestión de Riesgo Actualizada [${source.toUpperCase()} - ${profile.toUpperCase()}]`);
    res.json({ success: true, aiConfig: botStatus.aiConfig, whaleConfig: botStatus.whaleConfig });
});

// 2. Recibe la orden de Encender/Apagar el AutoTrade
app.post('/api/settings/autotrade', (req, res) => {
    const { enabled } = req.body;
    if (enabled !== undefined) botStatus.autoTradeEnabled = !!enabled;
    
    saveConfigToDisk("API Autotrade Toggle");
    res.json({ success: true, autoTradeEnabled: botStatus.autoTradeEnabled });
});

// 3. Toggle Copy-Trading (Custom y Auto separados)
app.post('/api/settings/copytrading', (req, res) => {
    const { customEnabled, autoEnabled, maxWhalesToCopy } = req.body;
    
    if (customEnabled !== undefined) botStatus.copyTradingCustomEnabled = !!customEnabled;
    if (autoEnabled !== undefined) botStatus.copyTradingAutoEnabled = !!autoEnabled;
    
    if (maxWhalesToCopy !== undefined) {
        botStatus.maxWhalesToCopy = parseInt(maxWhalesToCopy) || 5;
        botStatus.lastWhaleSelection = null;
    }
    
    saveConfigToDisk("API CopyTrading Toggle");
    res.json({ 
        success: true, 
        copyTradingCustomEnabled: botStatus.copyTradingCustomEnabled,
        copyTradingAutoEnabled: botStatus.copyTradingAutoEnabled 
    });
});

// ==========================================
// NUEVO: Configuración de filtros de Copy Trading
// ==========================================
app.post('/api/settings/copy-filters', (req, res) => {
    const { copyMinWhaleSize, copyTimeWindowMinutes } = req.body;

    if (copyMinWhaleSize !== undefined) botStatus.copyMinWhaleSize = parseInt(copyMinWhaleSize);
    if (copyTimeWindowMinutes !== undefined) botStatus.copyTimeWindowMinutes = parseInt(copyTimeWindowMinutes);

    saveConfigToDisk("Copy Filters Actualizados");

    console.log(`📋 Filtros Copy Trading actualizados → Tamaño mín: ${botStatus.copyMinWhaleSize} | Ventana: ${botStatus.copyTimeWindowMinutes} min`);

    res.json({ 
        success: true, 
        copyMinWhaleSize: botStatus.copyMinWhaleSize,
        copyTimeWindowMinutes: botStatus.copyTimeWindowMinutes 
    });
});

app.post('/api/settings/filters', (req, res) => {
    botStatus.marketFilters = { ...botStatus.marketFilters, ...req.body };
    
    saveConfigToDisk(); // 💾 AUTOGUARDADO
    
    console.log(`🛡️ Filtros de Mercado Actualizados y guardados:`, botStatus.marketFilters);
    res.json({ success: true, marketFilters: botStatus.marketFilters });
});

// ==========================================
// RUTA: ACTUALIZAR CONFIGURACIÓN GENERAL (LÍMITES)
// ==========================================
app.post('/api/settings/config', (req, res) => {
    try {
        const { maxActiveSportsMarkets, dailyLossLimit } = req.body;
        
        let updated = false;

        if (maxActiveSportsMarkets !== undefined) {
            botStatus.maxActiveSportsMarkets = parseInt(maxActiveSportsMarkets);
            updated = true;
        }
        
        if (dailyLossLimit !== undefined) {
            botStatus.dailyLossLimit = parseFloat(dailyLossLimit);
            updated = true;
        }

        if (updated) {
            saveConfigToDisk("API Configuración General");
            res.json({ success: true, message: "Configuración actualizada" });
        } else {
            res.status(400).json({ success: false, error: "Parámetros incompletos" });
        }
    } catch (error) {
        console.error("❌ Error en /api/settings/config:", error);
        res.status(500).json({ success: false, error: "Error interno del servidor" });
    }
});

// ==========================================
// RUTA: ACTUALIZAR RIESGO AVANZADO (SLIPPAGE/COOLDOWN)
// ==========================================
app.post('/api/settings/advanced-risk', (req, res) => {
    try {
        botStatus.riskSettings = { ...botStatus.riskSettings, ...req.body };
        saveConfigToDisk("API Advanced Risk");
        console.log(`🛡️ Variables de Slippage y Cooldown actualizadas y guardadas.`);
        res.json({ success: true, riskSettings: botStatus.riskSettings });
    } catch (error) {
        console.error("❌ Error en /api/settings/advanced-risk:", error);
        res.status(500).json({ success: false, error: "Error interno" });
    }
});

// ==========================================
// RUTA: CONTROLAR FONDO DE RESERVA PARA MODELOS IA
// ==========================================
app.post('/api/settings/ai-reserve', (req, res) => {
    const { amount } = req.body;
    if (amount !== undefined) {
        botStatus.aiReserveAmount = parseFloat(amount);
        saveConfigToDisk("Ajuste de Reserva IA");
        res.json({ success: true, aiReserveAmount: botStatus.aiReserveAmount });
    } else {
        res.status(400).json({ success: false, error: "Monto no válido" });
    }
});

app.post('/api/execute-trade', async (req, res) => {
    // 1. Extraemos los datos, incluyendo el respaldo del front
    const { market, amount, conditionId, tokenId, marketPrice: frontPrice } = req.body; 
    
    try {
        console.log(`\n🖱️ [MANUAL] Iniciando compra para: ${market}`);

        // 2. Intentar obtener precio fresco del Orderbook (CLOB)
        let finalPrice = await getMarketPrice(tokenId);
        
        // 3. Lógica de Respaldo (Fallback)
        if (!finalPrice || finalPrice === 0) {
            console.log("⚠️ Orderbook lento o sin respuesta. Usando precio de respaldo del Dashboard...");
            finalPrice = frontPrice; 
        }

        // 4. Validación final: Si después de todo sigue sin haber precio, abortamos
        if (!finalPrice) {
            throw new Error("No se pudo determinar un precio válido (Orderbook y Front fallaron).");
        }

        console.log(`⚖️ Precio final de ejecución: $${finalPrice} USDC`);

        // 5. Ejecutar en la Blockchain
        const result = await executeTradeOnChain(conditionId, tokenId, amount, finalPrice);

        if (result && result.success) {
            const execution = { 
                id: result.hash.substring(0, 10), 
                time: new Date().toLocaleTimeString(),
                action: "COMPRA MANUAL",
                market: market, 
                price: parseFloat(finalPrice),
                amount: parseFloat(amount), 
                status: "Completada ✅"
            };

            botStatus.executions.unshift(execution);
            if (botStatus.executions.length > 10) botStatus.executions.pop();
            
            // Limpiar la señal de "pendientes"
            botStatus.pendingSignals = botStatus.pendingSignals.filter(s => s.marketName !== market);
            
            await updateRealBalances();
            await sendAlert(`💰 *COMPRA MANUAL FINALIZADA*\n${market}\nPrecio: $${finalPrice} USDC`);
            
            res.json({ success: true, message: "Operación exitosa", hash: result.hash });
        }
    } catch (e) {
        console.error("❌ Error en Ejecución Manual:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});


// 🚀 ENDPOINT DE VENTA MANUAL
app.post('/api/sell', async (req, res) => {
    const { tokenId, shares } = req.body;

    if (!clobClient) {
        return res.status(500).json({ error: "Cliente CLOB no inicializado" });
    }

    try {
        console.log(`\n🔴 [VENTA MANUAL] Solicitud recibida para Token: ${tokenId.substring(0, 8)}...`);
        console.log(`   Acciones a vender: ${shares}`);

        // 1. Buscar a quién venderle (Mejor Bid en el libro de órdenes)
        const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, { httpsAgent: agent });
        
        if (!bookResp.data || !bookResp.data.bids || bookResp.data.bids.length === 0) {
            console.log("❌ No hay compradores en el mercado ahora mismo.");
            return res.status(400).json({ error: "Mercado sin liquidez de compra." });
        }

        // Tomamos el precio más alto que alguien está dispuesto a pagar
        const bestBidPrice = parseFloat(bookResp.data.bids[0].price);
        console.log(`   Mejor precio de venta encontrado: $${bestBidPrice}`);

        // 2. Ejecutar la Orden de Venta en la Blockchain
        const sellOrder = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: bestBidPrice,
            side: Side.SELL,
            size: parseFloat(shares)
        });

        console.log("✅ Venta ejecutada con éxito:", sellOrder);

        // 🟢 NUEVO: Alerta de Telegram calculando cuánto dinero rescataste
        const gananciaEstimada = (parseFloat(shares) * bestBidPrice).toFixed(2);
        await sendAlert(`💰 *POSICIÓN VENDIDA (MANUAL)*\nToken ID: \`${tokenId.substring(0,8)}...\`\nAcciones: ${shares}\nPrecio de Venta: $${bestBidPrice}\nTotal Rescatado: ~$${gananciaEstimada} USDC`);

        await updateRealBalances();
        res.json({ success: true, message: "Posición cerrada", data: sellOrder });

    } catch (error) {
        console.error("❌ Error en la venta:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 🚀 ENDPOINT DE PÁNICO (Freno de emergencia manual y automático)
app.post('/api/panic', (req, res) => {
    const { action } = req.body;
    
    if (action === 'stop') {
        botStatus.isPanicStopped = true;
        console.log("🚨 [EMERGENCIA] Bot detenido manualmente desde el panel.");
    } else if (action === 'resume') {
        botStatus.isPanicStopped = false;
        // 🔥 FIX: Reseteamos el balance inicial a 0 para que en el próximo ciclo tome el valor de tu cartera entera actual
        botStatus.dailyStartBalance = 0; 
        console.log("✅ [EMERGENCIA] Candado liberado. Bot reactivado.");
    }
    
    res.json({ success: true, isPanicStopped: botStatus.isPanicStopped });
});

// ====================== CUSTOM WHALES + AUTO TOGGLE ======================
app.get('/api/custom-whales', (req, res) => res.json(botStatus.customWhales || []));

app.post('/api/custom-whales', (req, res) => {
    try {
        const { address, nickname } = req.body;

        if (!address || typeof address !== 'string') {
            return res.status(400).json({ 
                success: false, 
                error: "Dirección es requerida" 
            });
        }

        const trimmedAddress = address.trim();

        if (!trimmedAddress.startsWith('0x') || trimmedAddress.length !== 42) {
            return res.status(400).json({ 
                success: false, 
                error: "Dirección inválida. Debe comenzar con 0x y tener exactamente 42 caracteres." 
            });
        }

        const normalizedAddress = trimmedAddress.toLowerCase();

        const exists = botStatus.customWhales.some(w => 
            w.address.toLowerCase() === normalizedAddress
        );

        if (exists) {
            return res.status(400).json({ 
                success: false, 
                error: "Esta ballena ya está agregada" 
            });
        }

        // Agregar la ballena
        botStatus.customWhales.push({ 
            address: normalizedAddress, 
            nickname: (nickname || "").trim(), 
            enabled: true 
        });

        saveConfigToDisk("Custom Whale Agregada");

        console.log(`✅ Ballena custom agregada correctamente: ${normalizedAddress}`);

        res.json({ 
            success: true, 
            message: "Ballena agregada correctamente",
            customWhales: botStatus.customWhales 
        });

    } catch (error) {
        console.error("❌ Error en /api/custom-whales:", error.message);
        res.status(500).json({ 
            success: false, 
            error: "Error interno del servidor al agregar la ballena" 
        });
    }
});

app.post('/api/custom-whales/toggle', (req, res) => {
    const { address, enabled } = req.body;
    const whale = botStatus.customWhales.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (whale) {
        whale.enabled = !!enabled;
        saveConfigToDisk("Custom Whale Toggle");
        res.json({ success: true });
    } else res.status(404).json({ success: false });
});

app.delete('/api/custom-whales', (req, res) => {
    const { address } = req.body;
    botStatus.customWhales = botStatus.customWhales.filter(w => w.address.toLowerCase() !== address.toLowerCase());
    saveConfigToDisk("Custom Whale Eliminada");
    res.json({ success: true, customWhales: botStatus.customWhales });
});

// ==========================================
// 🔥 NUEVO: API PARA REGLAS PERSONALIZADAS POR MERCADO (Parche #8)
// ==========================================

app.get('/api/settings/custom-rules', (req, res) => {
    res.json({ success: true, customMarketRules: botStatus.customMarketRules || [] });
});

// ==========================================
// API: Guardar / Editar TODAS las reglas personalizadas
// ==========================================
app.post('/api/settings/custom-rules', (req, res) => {
    try {
        const { rules } = req.body;
        if (!rules || !Array.isArray(rules)) return res.status(400).json({ success: false, error: "Se esperaba un array" });

        for (const rule of rules) {
            rule.keyword = (rule.keyword || "").trim();
            rule.takeProfitThreshold = parseInt(rule.takeProfitThreshold) || 25;
            rule.stopLossThreshold = parseInt(rule.stopLossThreshold) || -30;
            rule.microBetAmount = parseFloat(rule.microBetAmount) || 2.0;
            // 🔥 NUEVO: Guardar Edge y Probabilidad
            rule.edgeThreshold = parseFloat(rule.edgeThreshold) || undefined;
            rule.predictionThreshold = parseFloat(rule.predictionThreshold) || undefined;
        }

        botStatus.customMarketRules = rules;
        saveConfigToDisk("Reglas personalizadas actualizadas (edición)");
        console.log(`📋 ${rules.length} reglas personalizadas guardadas correctamente`);
        res.json({ success: true, customMarketRules: botStatus.customMarketRules });

    } catch (error) {
        console.error("❌ Error en /api/settings/custom-rules:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/settings/custom-rules', (req, res) => {
    try {
        const { keyword } = req.body;
        botStatus.customMarketRules = botStatus.customMarketRules.filter(r => 
            r.keyword.toLowerCase() !== keyword.toLowerCase()
        );
        saveConfigToDisk("Regla Eliminada");
        res.json({ success: true, customMarketRules: botStatus.customMarketRules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🔥 NUEVO: Límite de mercados por ballena (Parche #9)
// ==========================================
app.post('/api/settings/copy-limit-per-whale', (req, res) => {
    try {
        const { maxCopyMarketsPerWhale } = req.body;
        
        if (maxCopyMarketsPerWhale === undefined) {
            return res.status(400).json({ success: false, error: "Valor requerido" });
        }

        botStatus.maxCopyMarketsPerWhale = parseInt(maxCopyMarketsPerWhale);
        saveConfigToDisk("Límite por Ballena Actualizado");

        console.log(`📋 Límite por ballena cambiado a: ${botStatus.maxCopyMarketsPerWhale} mercados`);

        res.json({ success: true, maxCopyMarketsPerWhale: botStatus.maxCopyMarketsPerWhale });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🎛️ ENDPOINTS: QUANTUM EQUALIZER
// ==========================================
app.post('/api/settings/equalizer', (req, res) => {
    try {
        const { enabled, shockThreshold, betAmount } = req.body;
        
        if (enabled !== undefined) botStatus.equalizerEnabled = Boolean(enabled);
        if (shockThreshold !== undefined) botStatus.equalizerShockThreshold = parseFloat(shockThreshold);
        if (betAmount !== undefined) botStatus.equalizerBetAmount = parseFloat(betAmount);
        
        saveConfigToDisk("Ajuste Quantum Equalizer");
        
        console.log(`🌊 [EQUALIZER] Ajustes actualizados: ON=${botStatus.equalizerEnabled} | Salto=${botStatus.equalizerShockThreshold}% | Disparo=$${botStatus.equalizerBetAmount}`);
        
        res.json({ 
            success: true, 
            message: "Ecualizador actualizado",
            state: {
                enabled: botStatus.equalizerEnabled,
                shockThreshold: botStatus.equalizerShockThreshold,
                betAmount: botStatus.equalizerBetAmount
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🎛️ ENDPOINTS: CHRONOS HARVESTER
// ==========================================
app.post('/api/settings/chronos', (req, res) => {
    try {
        const { enabled, betAmount, minPrice, maxPrice, hoursLeft } = req.body;
        
        if (enabled !== undefined) botStatus.chronosEnabled = Boolean(enabled);
        if (betAmount !== undefined) botStatus.chronosBetAmount = parseFloat(betAmount);
        if (minPrice !== undefined) botStatus.chronosMinPrice = parseFloat(minPrice);
        if (maxPrice !== undefined) botStatus.chronosMaxPrice = parseFloat(maxPrice);
        if (hoursLeft !== undefined) botStatus.chronosHoursLeft = parseInt(hoursLeft); // <-- NUEVO
        
        saveConfigToDisk("Ajuste Chronos Harvester");
        
        console.log(`⏳ [CHRONOS] Ajustes actualizados: ON=${botStatus.chronosEnabled} | Rango=$${botStatus.chronosMinPrice}-$${botStatus.chronosMaxPrice} | Disparo=$${botStatus.chronosBetAmount} | Horas=${botStatus.chronosHoursLeft}`);
        
        res.json({ success: true, message: "Chronos actualizado" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🎛️ ENDPOINTS: KINETIC PRESSURE (ACTUALIZADO)
// ==========================================
app.post('/api/settings/kinetic', (req, res) => {
    try {
        const { enabled, betAmount, imbalanceRatio, depthPercent, maxPositions } = req.body;
        
        if (enabled !== undefined) botStatus.kineticEnabled = Boolean(enabled);
        if (betAmount !== undefined) botStatus.kineticBetAmount = parseFloat(betAmount);
        if (imbalanceRatio !== undefined) botStatus.kineticImbalanceRatio = parseFloat(imbalanceRatio);
        if (depthPercent !== undefined) botStatus.kineticDepthPercent = parseFloat(depthPercent);
        
        // 🔥 Guardamos el nuevo límite dinámico
        if (maxPositions !== undefined) botStatus.kineticMaxPositions = parseInt(maxPositions);
        
        saveConfigToDisk("Ajuste Kinetic Pressure");
        
        console.log(`🌊 [KINETIC] Ajustes: ON=${botStatus.kineticEnabled} | Ratio=${botStatus.kineticImbalanceRatio}:1 | Límite=${botStatus.kineticMaxPositions} POS`);
        
        res.json({ success: true, message: "Kinetic actualizado" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// REPORTES DIARIOS (Motor Cron de Alta Precisión)
// ==========================================
const MEXICO_TZ = 'America/Mexico_City';

async function sendDailySummary(title) {
    try {
        await updateRealBalances();   // ← Muy importante

        const polyBalance = parseFloat(botStatus.clobOnlyUSDC || 0);
        const metaBalance = parseFloat(botStatus.walletOnlyUSDC || 0);
        const unclaimed = parseFloat(botStatus.unclaimedUSDC || 0);

        // 🔥 FIX QUANT 1: Calcular el valor de las posiciones vivas
        const activePosValue = botStatus.activePositions ? botStatus.activePositions.reduce((acc, pos) => {
            if (pos.status && (pos.status.includes('CANJEAR') || pos.status.includes('PERDIDO'))) return acc;
            return acc + parseFloat(pos.currentValue || 0);
        }, 0) : 0;

        // 🔥 FIX QUANT 2: Calcular el PnL Flotante matemáticamente
        let floatingPnL = 0;
        if (botStatus.activePositions) {
            floatingPnL = botStatus.activePositions.reduce((acc, pos) => {
                if (pos.status && (pos.status.includes('CANJEAR') || pos.status.includes('PERDIDO'))) return acc;
                return acc + parseFloat(pos.cashPnl || 0);
            }, 0);
        }

        // Ahora sí, la cartera es 100% precisa
        const total = (polyBalance + metaBalance + unclaimed + activePosValue).toFixed(2);
        const activeCount = botStatus.activePositions ? botStatus.activePositions.length : 0;

        const msg = `${title}\n\n` +
                    `💰 *Cartera Total:* $${total} USDC\n` +
                    `📈 PnL Flotante: *${floatingPnL >= 0 ? '+' : ''}$${floatingPnL.toFixed(2)} USDC*\n` +
                    `📍 Posiciones Activas: *${activeCount}*\n` +
                    `🕒 Hora: *${new Date().toLocaleString('es-MX', { timeZone: MEXICO_TZ })}*`;

        await sendAlert(msg);
        console.log(`📧 Reporte enviado: ${title}`);
    } catch (error) {
        console.error(`❌ Error enviando reporte diario (${title}):`, error.message);
    }
}

function scheduleDailyReports() {
    console.log("⏰ Motor Cron iniciado: Reportes programados (America/Mexico_City).");

    const config = {
        scheduled: true,
        timezone: MEXICO_TZ
    };

    // Sintaxis Cron: 'minuto hora * * *' (formato 24h)
    
    // 12:00 PM (Mediodía)
    cron.schedule('0 12 * * *', () => {
        sendDailySummary("🌞 Resumen de Mediodía (12:00 PM MX)");
    }, config);

    // 6:00 PM (Tarde)
    cron.schedule('0 18 * * *', () => {
        sendDailySummary("🌅 Resumen de la Tarde (6:00 PM MX)");
    }, config);

    // 11:59 PM (Cierre de día)
    cron.schedule('59 23 * * *', () => {
        sendDailySummary("🌙 Resumen Final del Día (11:59 PM MX)");
    }, config);
}

// ==========================================
// 📡 RADAR QUANT DE BALLENAS (MACRO/LONG-TERM)
// ==========================================
function isShortTermMarket(title) {
    const t = (title || "").toLowerCase();
    return /up or down|above .* on|by .* [0-9]+:[0-9]+|3:.*pm-4:.*pm|4:.*pm-5:.*pm|15m|5m|10m|minute|minutos/.test(t);
}

function isLongTermMarket(title) {
    const t = (title || "").toLowerCase();
    return /by april|by may|by june|by july|by 2026|2026|trump say|zelensky|ukraine|russia|fed|cpi|election|congress|starmer|warsh|pokrovsk|iran|israel|kevin warsh|nasdaq|sp500|interest rate|elon|tesla|spacex|munich|sao paulo|temperature|will there be|will trump|will russia|will bitcoin|will ethereum/.test(t);
}

function timeAgo(timestamp) {
    if (!timestamp) return "Desconocido";
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return "hace segundos";
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} hrs`;
    return `hace ${Math.floor(diff / 86400)} días`;
}

async function runWhaleRadar() {
    if (whaleRadarCache.isScanning) return;
    whaleRadarCache.isScanning = true;

    try {
        console.log("🌊 [RADAR] Iniciando escaneo profundo de ballenas macro...");
        const tradeRes = await axios.get('https://data-api.polymarket.com/trades?limit=1000', {
            httpsAgent: agent,
            timeout: 15000
        });

        let trades = Array.isArray(tradeRes.data) ? tradeRes.data : (tradeRes.data.data || []);
        const whaleStats = {};

        for (const trade of trades) {
            const address = trade.proxyWallet || trade.maker_address || trade.user;
            if (!address) continue;

            const volume = (parseFloat(trade.size) || 0) * (parseFloat(trade.price) || 0);
            const title = (trade.title || "").toLowerCase();
            const ts = trade.timestamp || 0;
            const nickname = trade.pseudonym || trade.name || address.substring(0, 5);

            if (!whaleStats[address]) {
                whaleStats[address] = {
                    address, nickname, totalVolume: 0, relevantVolume: 0,
                    tradeCount: 0, markets: new Set(), lastTimestamp: 0
                };
            }

            whaleStats[address].totalVolume += volume;
            whaleStats[address].tradeCount += 1;
            if (trade.conditionId || title) whaleStats[address].markets.add(trade.conditionId || title);
            if (ts > whaleStats[address].lastTimestamp) whaleStats[address].lastTimestamp = ts;

            const isShort = isShortTermMarket(title);
            const isLong = isLongTermMarket(title);

            if (!isShort && isLong) {
                whaleStats[address].relevantVolume += volume;
            }
        }

        const whalesArray = Object.values(whaleStats)
            .filter(w => w.totalVolume > 100 && w.tradeCount > 2)
            .map(w => {
                const relevance = w.totalVolume > 0 ? Math.round((w.relevantVolume / w.totalVolume) * 100) : 0;
                
                // Sistema de Estrellas/Recomendación tipo Quant
                let stars = 0;
                let rec = "No recomendado";
                if (relevance >= 80 && w.relevantVolume > 500) { stars = 5; rec = "TOP MACRO"; }
                else if (relevance >= 60) { stars = 4; rec = "Excelente"; }
                else if (relevance >= 40) { stars = 3; rec = "Aceptable"; }
                else if (relevance >= 20 && w.totalVolume > 2000) { stars = 2; rec = "Volumen Mixto"; }
                else if (relevance > 0) { stars = 1; rec = "Baja Relevancia"; }

                return {
                    address: w.address,
                    nickname: w.nickname,
                    totalVolume: w.totalVolume,
                    relevantVolume: w.relevantVolume,
                    relevanceScore: relevance,
                    tradeCount: w.tradeCount,
                    marketCount: w.markets.size,
                    lastActivity: timeAgo(w.lastTimestamp),
                    stars,
                    recommendation: rec,
                    rawTimestamp: w.lastTimestamp
                };
            })
            .sort((a, b) => b.relevanceScore - a.relevanceScore || b.totalVolume - a.totalVolume)
            .slice(0, 15); // Guardamos el Top 15

        whaleRadarCache.whales = whalesArray;
        whaleRadarCache.lastScan = new Date().toLocaleTimeString();

        // 🔥 LA MAGIA: Ejecutamos el administrador de nómina
        manageWhaleRoster(whalesArray);

        console.log(`✅ [RADAR] Escaneo completo. Top 1 detectado: ${whalesArray[0]?.nickname || 'N/A'}`);

    } catch (error) {
        console.error("❌ [RADAR] Error escaneando:", error.message);
    } finally {
        whaleRadarCache.isScanning = false;
    }
}

// ==========================================
// 🏢 RECURSOS HUMANOS QUANT (Auto-Gestión y Meritocracia)
// ==========================================
function manageWhaleRoster(radarWhales) {
    if (!botStatus.copyTradingCustomEnabled) return;

    const now = Date.now();
    let removedZombies = 0;
    let addedTopWhales = 0;
    const MAX_WHALE_ROSTER = 15; // 🔥 LÍMITE INSTITUCIONAL DE PLANTILLA

    // 1. DESPEDIR ZOMBIES ABSOLUTOS (Más de 15 días inactivos)
    botStatus.customWhales = botStatus.customWhales.filter(whale => {
        if (whale.lastActive) {
            const diffDays = (now - whale.lastActive) / (1000 * 60 * 60 * 24);
            if (diffDays > 15) {
                console.log(`🧟‍♂️ [AUTO-CLEAN] Eliminando ballena Zombie (Ausente > 15 días): ${whale.nickname || whale.address}`);
                removedZombies++;
                return false; 
            }
        }
        return true; 
    });

    // 2. CONTRATAR TALENTO FRESCO Y GESTIONAR MERITOCRACIA
    for (const rw of radarWhales) {
        if (rw.stars >= 4) {
            const exists = botStatus.customWhales.some(w => w.address.toLowerCase() === rw.address.toLowerCase());
            
            if (!exists) {
                // ESCENARIO A: Hay espacio en la plantilla
                if (botStatus.customWhales.length < MAX_WHALE_ROSTER) {
                    botStatus.customWhales.push({
                        address: rw.address.toLowerCase(),
                        nickname: rw.nickname || "Auto-Quant",
                        enabled: true,
                        lastActive: rw.rawTimestamp ? rw.rawTimestamp * 1000 : Date.now()
                    });
                    console.log(`🌟 [AUTO-HIRE] Nueva ballena agregada: ${rw.nickname || rw.address}`);
                    addedTopWhales++;
                } 
                // ESCENARIO B: Plantilla llena, pero el candidato es un TOP MACRO (5 Estrellas)
                else if (rw.stars === 5) {
                    const sortedWhales = [...botStatus.customWhales].sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));
                    const peorEmpleado = sortedWhales[0];
                    const diasInactivo = (now - (peorEmpleado.lastActive || 0)) / (1000 * 60 * 60 * 24);

                    // 🔥 FIX QUANT: Tolerancia Macro. Un francotirador puede no operar en una semana.
                    // Solo hacemos el intercambio si nuestro peor empleado lleva más de 7 días dormido.
                    if (diasInactivo >= 7) {
                        console.log(`🔀 [MERITOCRACIA] Despidiendo a ${peorEmpleado.nickname || peorEmpleado.address.substring(0,8)} (Inactivo ${Math.floor(diasInactivo)} días) para contratar a la superestrella ${rw.nickname || rw.address}`);
                        
                        botStatus.customWhales = botStatus.customWhales.filter(w => w.address !== peorEmpleado.address);
                        
                        botStatus.customWhales.push({
                            address: rw.address.toLowerCase(),
                            nickname: rw.nickname || "Auto-Quant",
                            enabled: true,
                            lastActive: rw.rawTimestamp ? rw.rawTimestamp * 1000 : Date.now()
                        });
                        addedTopWhales++;
                    }
                }
            }
        }
    }

    if (removedZombies > 0 || addedTopWhales > 0) {
        saveConfigToDisk("Auto-Gestión de Ballenas (RRHH)");
    }
}

// ==========================================
// 🧹 QUANT GARBAGE COLLECTOR (Anti-Fugas de Memoria a Largo Plazo)
// ==========================================
function runGarbageCollector() {
    console.log("🧹 [SYSTEM] Ejecutando Limpieza Profunda de Memoria (Garbage Collector)...");
    const now = Date.now();

    // 1. Limpiar priceHistoryCache (Mercados que ya no están en la Watchlist)
    const activeTokens = new Set();
    botStatus.watchlist.forEach(m => {
        if (m.tokenYes) activeTokens.add(m.tokenYes);
        if (m.tokenNo) activeTokens.add(m.tokenNo);
    });

    for (const tokenId in priceHistoryCache) {
        if (!activeTokens.has(tokenId)) {
            delete priceHistoryCache[tokenId]; // Borra el token muerto de la RAM
        }
    }

    // 2. Limpiar botStatus.lastTrades (Cooldowns antiguos mayores a 24 horas)
    for (const tokenId in botStatus.lastTrades) {
        if (now - botStatus.lastTrades[tokenId] > 24 * 60 * 60 * 1000) {
            delete botStatus.lastTrades[tokenId]; // Borra el registro histórico
        }
    }
}

// ENDPOINT PARA EL DASHBOARD
app.get('/api/radar', (req, res) => {
    res.json(whaleRadarCache);
});
app.post('/api/radar/force', async (req, res) => {
    await runWhaleRadar();
    res.json(whaleRadarCache);
});

// ==========================================
// 11. INICIO DEL MOTOR DEL SNIPER
// ==========================================
app.listen(PORT, async () => {
    console.log(`\n======================================================`);
    console.log(`🎯 POLY-SNIPER V2: SERVIDOR ACTIVO EN PUERTO ${PORT}`);
    console.log(`======================================================\n`);
    
    // 🔥 DISPARAMOS EL AUTO-SELECTOR ANTES DE ARRANCAR EL BOT
    await initGemini();

    // ==================== INTERVALOS RECOMENDADOS ====================

    // 1. Motor principal de IA + Sniper (análisis de mercados)
    setInterval(runBot, 75000);           // ← 75 segundos (ideal)

    // 2. Vigilancia de ganancias y PnL
    setInterval(monitorPortfolio, 180000); // 3 minutos → está bien, se puede dejar

    // 3. Copy Trading (el más importante de ajustar)
    setInterval(checkAndCopyWhaleTrades, 30000); // ← 30 segundos (recomendado)

    // 4. Guardián del servidor (RAM + CPU)
    setInterval(monitorSystemHealth, 90000); // 90 segundos → suficiente

    // 5. Auto Redeem cada 5 minutos
    setInterval(autoRedeemPositions, 300000);   // 5 minutos

    // 🐋 6. Radar de Ballenas Macro (Cada 1 Hora en lugar de 15 min)
    setInterval(runWhaleRadar, 60 * 60 * 1000);
    setTimeout(runWhaleRadar, 5000); // Primer escaneo a los 5s de arrancar

    // 🌊 7. Quantum Equalizer: Alimentador de Memoria (Cada 60 segundos)
    setInterval(updateHighFrequencyRadar, 60 * 1000);

    // 🌊 8. Quantum Equalizer: Escáner de Shocks de Liquidez (Cada 2 minutos)
    setInterval(checkForLiquidityShocks, 2 * 60 * 1000);

    // ⏳ 9. Chronos Harvester: Cosechador de Theta Decay (Cada 15 minutos)
    setInterval(runChronosHarvester, 15 * 60 * 1000);

    // 🌊 10. Kinetic Pressure: Radar de Desequilibrio (Cada 20 segundos)
    setInterval(runKineticPressureScanner, 20 * 1000);

    // 🧹 11. Garbage Collector: Limpieza profunda de RAM (Cada 12 horas)
    setInterval(runGarbageCollector, 12 * 60 * 60 * 1000);

    // 🔥 Reportes diarios automáticos (12:00 PM, 6:00 PM y 11:59 PM)
    scheduleDailyReports();

    // Arranque inicial controlado
    updateRealBalances().then(() => {
        runBot();   // Primera ejecución inmediata
    });
});