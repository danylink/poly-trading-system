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
    lastTrades: {} // Objeto para controlar el Cooldown: { tokenId: timestamp }
};


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
            copyTimeWindowMinutes: botStatus.copyTimeWindowMinutes
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
// 2. ACTUALIZACIÓN DE SALDOS (NATIVA CLOB)
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
            
            if (clobMonto === 0) {
                await clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" });
            }
            botStatus.clobOnlyUSDC = clobMonto.toFixed(2);
            botStatus.balanceUSDC = botStatus.clobOnlyUSDC;
        }

        // 4. Posiciones activas (Data API)
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
            
            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=50`);
            const positions = await response.json();
            
            botStatus.activePositions = []; 
            let totalUnclaimed = 0; 
            
            if (Array.isArray(positions) && positions.length > 0) {
                for (const pos of positions) {
                    const size = parseFloat(pos.size || pos['tamaño'] || 0);
                    
                    if (size < 0.1) continue; 

                    const cashPnl = parseFloat(pos.cashPnl || pos['ganancias en efectivo'] || 0);
                    const percentPnl = parseFloat(pos.percentPnl || pos['porcentaje de ganancias'] || 0);
                    const valorActual = parseFloat(pos.currentValue || pos.current_value || pos.value || 0);

                    const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                    // 🔥 Dejamos que sume al unclaimed, pero ELIMINAMOS el "continue"
                    // para que la posición siga bajando y se agregue al Dashboard.
                    if (isRedeemable) {
                        totalUnclaimed += valorActual;
                        if (!redeemedCache.has(pos.asset || pos.token_id)) {
                            redeemedCache.add(pos.asset || pos.token_id);
                        }
                    }

                    // 🔥 DETECTOR DE OUTCOME (YES / NO) PARA EL FRONTEND
                    let outcomeVal = "N/A";
                    if (pos.outcome) {
                        outcomeVal = String(pos.outcome).toUpperCase(); 
                    } else if (pos.assetName && typeof pos.assetName === 'string') {
                        if (pos.assetName.toUpperCase().includes("-YES")) outcomeVal = "YES";
                        else if (pos.assetName.toUpperCase().includes("-NO")) outcomeVal = "NO";
                    }

                    botStatus.activePositions.push({
                        tokenId: pos.asset || pos.token_id || pos.asset_id,
                        conditionId: pos.conditionId || pos.condition_id,
                        size: size.toFixed(2),
                        exactSize: size,
                        marketName: pos.title || pos.market || pos['título'] || "Mercado Desconocido",
                        // 👇 Etiqueta dinámica: Si es canjeable, cambia visualmente
                        status: isRedeemable ? "CANJEAR 🎁" : "ACTIVO 🟢",
                        currentValue: valorActual.toFixed(2),
                        cashPnl: cashPnl,
                        percentPnl: percentPnl,
                        category: getMarketCategoryEnhanced(pos.title || pos.market || pos['título'] || ""),
                        outcome: outcomeVal 
                    });
                }
            }
            
            botStatus.unclaimedUSDC = totalUnclaimed.toFixed(2);

        } catch (apiError) {
            console.log("⚠️ No se pudieron obtener posiciones:", apiError.message);
        }

        // 🔥 IMPRESIÓN DE BALANCES
        if (Math.random() < 0.25) {
            const metaMaskVal = parseFloat(botStatus.walletOnlyUSDC || 0);
            const polyVal = parseFloat(botStatus.clobOnlyUSDC || 0);
            const unclaimedVal = parseFloat(botStatus.unclaimedUSDC || 0);
            
            // 👇 FIX DE DOBLE SUMA: Ignoramos las posiciones canjeables aquí porque ya están en unclaimedVal
            const activePosValue = botStatus.activePositions.reduce((acc, pos) => {
                if (pos.status === "CANJEAR 🎁") return acc;
                return acc + parseFloat(pos.currentValue || 0);
            }, 0);

            const carteraTotalReal = (metaMaskVal + polyVal + activePosValue + unclaimedVal).toFixed(2);

            console.log(`📊 Balances: Cartera Total: $${carteraTotalReal} | Disponible (Poly): $${polyVal.toFixed(2)} | MetaMask: $${metaMaskVal.toFixed(2)} | Gas: ${botStatus.balancePOL} POL`);
        }

    } catch (e) { 
        console.error("❌ Error general actualizando balances:", e.message); 
    }
}

// ==========================================
// 3A. MOTOR DE IA 1 (CLAUDE) - Versión Mejorada
// ==========================================
async function analyzeMarketWithClaude(marketQuestion, currentNews, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 180,
                system: `Eres un Senior Quant Trader especializado en Polymarket.

Prioriza primero mercados de política, business, eventos de Trump, Fed, CPI y similares, ya que suelen tener mejor edge y menos ruido.
Solo después considera mercados crypto cortos con momentum o hype claro.

Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}

REGLAS CLAVE:
- Mercados de política/business/Trump (hasta 72 horas): edge > 0.08 es bueno.
- Mercados crypto cortos (<30 min): edge > 0.06 es válido solo si hay momentum o hype fuerte.
- Prefiere calidad sobre cantidad. Mejor una buena señal de política que muchas marginales de 5 minutos.
- Sé honesto con la probabilidad. Nunca fuerces 50% si ves ventaja real.
- Solo responde "WAIT" cuando realmente no hay edge claro.`,

                messages: [{ role: "user", content: `Mercado: ${marketQuestion}\nNoticias: ${currentNews}\nAnaliza ventaja real en las próximas 72 horas.` }]
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
// 3B. MOTOR DE IA 2 (GEMINI) - Versión Equilibrada
// ==========================================
async function analyzeMarketWithGemini(marketQuestion, currentNews) {
    console.log("🧠 Gemini Short-Term Analysis...");

    try {
        const prompt = `Eres un Senior Quant Trader especializado en Polymarket.

Prioriza primero mercados de política, business, eventos de Trump, Fed, CPI y similares (hasta 72 horas), porque suelen tener mejor edge y menos ruido.
Solo después considera mercados crypto cortos con momentum o hype.

Responde ESTRICTAMENTE con este JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "HYPE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara (máx 15 palabras)",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}

REGLAS CLAVE:
- Mercados política/business/Trump (hasta 72h): edge > 0.08 es bueno.
- Mercados crypto cortos (<30 min): edge > 0.06 es válido si hay hype fuerte.
- Prefiere calidad. Mejor una señal sólida de política que muchas marginales de 5 minutos.
- Sé honesto con la probabilidad.

Mercado: ${marketQuestion}
Noticias recientes: ${currentNews}`;

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
        console.error("❌ Error en motor Gemini:", error.message);
        return { 
            isError: true, 
            prob: 0, 
            strategy: "WAIT", 
            urgency: 0, 
            reason: "Error Gemini", 
            edge: 0, 
            recommendation: "WAIT" 
        };
    }
}

// ==========================================
// 3C. MOTOR DE IA 3 (GROK / xAI) - Versión Mejorada
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
                        content: `Eres un Quant Trader especializado en Polymarket.

Primero prioriza mercados de política, business, eventos de Trump, Fed y CPI (hasta 72 horas), ya que suelen tener mejor edge.
Después considera crypto corto con momentum o hype fuerte.

Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "MOMENTUM" | "NEWS_ARBITRAGE" | "HYPE" | "TIME_EDGE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}

REGLAS:
- Política/business/Trump (hasta 72h): edge > 0.08 es bueno.
- Crypto corto: edge > 0.06 es válido solo si hay hype claro.
- Prefiere calidad sobre cantidad.
- Sé honesto con la probabilidad.`
                    },
                    {
                        role: "user",
                        content: `Mercado: ${marketQuestion}\nNoticias recientes: ${currentNews}\nAnaliza ventaja real en las próximas 72 horas.`
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
                reason: data.reason || "Sin momentum claro",
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

// 🟢 FUNCIÓN RECUPERADA Y MEJORADA PARA AUTO-TRADE
async function sendSniperAlert(signal) {
    const edgePct = signal.edge >= 0 ? `+${(signal.edge * 100).toFixed(1)}%` : `${(signal.edge * 100).toFixed(1)}%`;
    const msg = `🎯 *SNIPER AUTOMÁTICO EJECUTADO*\n\n📋 *Mercado:* ${signal.marketName}\n🧠 *Confianza IA:* ${(signal.probability * 100).toFixed(0)}%\n📊 *Precio de Compra:* $${signal.marketPrice}\n📈 *Ventaja (Edge):* ${edgePct}\n💰 *Inversión:* $${signal.suggestedInversion} USDC\n📝 *Razón:* ${signal.reasoning}`;
    
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

    // 🔥 EL FIX QUANT: Etiquetar correctamente los deportes
    if (lower.match(/nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|league|champions|madrid|lakers|sports|yankees|fc|atp|wta|match|inning/i)) return 'SPORTS';
    if (lower.includes(" vs ")) return 'SPORTS'; // El clásico formato "Equipo A vs Equipo B"

    return null;
}

// ==========================================
// 7. ACTUALIZACIÓN DE WATCHLIST (PARCHE #3)
// ==========================================
async function refreshWatchlist() {
    try {
        botStatus.currentTopic = 'Buscando solo mercados que cierran en <48h...';
        console.log(`\n⏰ [SNIPER] Escaneando SOLO mercados cortos (<48h)...`);

        const res = await axios.get(
            'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&dir=desc',
            { httpsAgent: agent }
        );

        const now = Date.now();

        // 🔥 PARCHE #3: FILTRO MUY ESTRICTO
        const futureMarkets = res.data.filter(m => {
            if (!m.conditionId || !m.endDate) return false;
            
            const hoursLeft = hoursUntilClose(m.endDate);
            const volume = parseFloat(m.volume || 0);

            // Solo aceptamos mercados que cierren en máximo 48 horas
            return new Date(m.endDate).getTime() > now && hoursLeft <= 48;
        });

        const targetedMarkets = futureMarkets.map(m => ({
            ...m,
            category: getMarketCategoryEnhanced(m.question)
        })).filter(m => m.category !== null);

        // Ordenamos por tiempo restante (los que cierran antes primero)
        targetedMarkets.sort((a, b) => {
            const hrsA = hoursUntilClose(a.endDate);
            const hrsB = hoursUntilClose(b.endDate);
            return hrsA - hrsB;
        });

        const finalPool = [];
        const cats = ['SHORT_TERM', 'CRYPTO', 'GEOPOLITICS', 'BUSINESS']; // quitamos SOCIAL si quieres ser más conservador
        let idx = 0;

        // Máximo 12 mercados en el pool (más calidad, menos ruido)
        while (finalPool.length < 12 && targetedMarkets.length > 0) {
            const cat = cats[idx % cats.length];
            const match = targetedMarkets.findIndex(m => m.category === cat);
            if (match !== -1) {
                finalPool.push(targetedMarkets[match]);
                targetedMarkets.splice(match, 1);
            } else if (targetedMarkets.length > 0) {
                finalPool.push(targetedMarkets.shift());
            }
            idx++;
        }

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
                endsIn: hrs < 1 ? `${Math.round(hrs*60)}m` : `${hrs.toFixed(1)}h`,
                tickSize: market.minimum_tick_size || "0.01",
                volume: parseFloat(market.volume || 0)
            };
        });

        botStatus.watchlist = rawTrends;
        console.log(`🎯 Pool seleccionado: ${rawTrends.length} mercados (TODOS cierran en <48h)`);

    } catch (e) {
        console.error('❌ Error refreshWatchlist:', e.message);
    }
}

// ==========================================
// 8. EJECUCIÓN DE COMPRA - VERSIÓN CORREGIDA (Mínimo 5 shares)
// ==========================================
async function executeTradeOnChain(conditionId, tokenId, amountUsdc, currentPrice, marketTickSize = "0.01") {
    try {
        console.log(`\n--- ⚖️ EJECUCIÓN ON-CHAIN EN POLYMARKET ---`);

        if (!clobClient) throw new Error("clobClient no está inicializado.");

        // 1. Auto-limpieza
        console.log("🧹 Liberando USDC de órdenes anteriores...");
        try { await clobClient.cancelAll(); } catch (e) {}

        // 2. Datos del mercado
        let trueTickSize = String(marketTickSize);
        let isNegRisk = false;

        try {
            const clobMarket = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
            if (clobMarket.data) {
                if (clobMarket.data.neg_risk === true) isNegRisk = true;
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

        // ====================== CÁLCULO CORREGIDO ======================
        let targetAmount = parseFloat(amountUsdc);           // lo que queremos gastar ($2 o $3)
        let numShares = Number((targetAmount / limitPrice).toFixed(3));

        // FORZAMOS mínimo 5 shares (Polymarket lo exige en casi todos los mercados)
        if (numShares < 5) {
            numShares = 5;
            console.log(`⚠️ Ajustando a mínimo 5 shares → Monto real: $${(5 * limitPrice).toFixed(2)}`);
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
// CHECK AND COPY WHALE TRADES - VERSIÓN CON LÍMITE POR BALLENA (Parche #9.1)
// ==========================================
let isScanningWhales = false;

async function checkAndCopyWhaleTrades() {
    if (isScanningWhales) return;

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
            // 1. Si el objeto actual ya tiene nickname → usarlo
            if (whale.nickname && whale.nickname.trim() !== '') {
                return whale.nickname;
            }

            // 2. Buscar en el config global por dirección (garantía 100%)
            const configWhale = botStatus.customWhales.find(w => 
                w.address.toLowerCase() === whale.address.toLowerCase()
            );
            if (configWhale && configWhale.nickname && configWhale.nickname.trim() !== '') {
                return configWhale.nickname;
            }

            // 3. Fallback final
            return whale.address.substring(0, 8) + "...";
        };

        // =======================================================================

        for (const whale of allWhales) {
            try {
                const copiedFromThisWhale = botStatus.copiedPositions.filter(p => 
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

                    // ==================== COPIA DE COMPRA ====================
                    if (side === "BUY") {
                        if (botStatus.isPanicStopped) continue;
                        if (!isMarketAllowed(title)) continue;

                        if (botStatus.maxActiveSportsMarkets > 0 && botStatus.copiedPositions.length >= botStatus.maxActiveSportsMarkets) continue;

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

                            // 🔥 NUEVO: Guardamos también el nickname
                            botStatus.copiedTrades.unshift({
                                id: Date.now(),
                                txHash,
                                whale: whale.address.substring(0,10) + "...",
                                nickname: whale.nickname || getWhaleDisplayName(whale),   // ← AQUÍ SE GUARDA EL NICKNAME
                                tokenId,
                                size: montoInversion,
                                price: limitPrice,
                                time: new Date().toLocaleTimeString(),
                                market: title
                            });

                            if (botStatus.copiedTrades.length > 20) botStatus.copiedTrades.pop();

                            // 🔥 NUEVO: Guardamos también el nickname en copiedPositions
                            botStatus.copiedPositions.push({
                                tokenId,
                                whale: whale.address,
                                nickname: whale.nickname || getWhaleDisplayName(whale),   // ← AQUÍ SE GUARDA EL NICKNAME
                                sizeCopied: montoInversion,
                                priceEntry: limitPrice,
                                marketName: title
                            });

                            saveConfigToDisk("Nueva Ballena Copiada");

                            botStatus.copyTradingStats.totalCopied = (botStatus.copyTradingStats.totalCopied || 0) + 1;
                            botStatus.copyTradingStats.successful = (botStatus.copyTradingStats.successful || 0) + 1;

                            await sendAlert(`🐋 *COPY BUY*\nBallena: ${getWhaleDisplayName(whale)}\nMercado: ${title.substring(0,45)}...\nInversión: $${montoInversion.toFixed(2)}`);

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
                            await sendAlert(`🛑 *COPY SELL*\nBallena: ${position.nickname || getWhaleDisplayName(whale)}\nMercado: ${title.substring(0,40)}...\nRescatado ≈ $${rescateEst} USDC`);
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
    }
}

// 🛡️ ESCÁNER DE CATEGORÍAS (VERSIÓN BLINDADA)
function isMarketAllowed(title = "", slug = "") {
    const text = `${title} ${slug}`.toLowerCase();

    // Regex SÚPER AGRESIVO para bloquear TODO tipo de deportes, equipos y ligas
    const isSports = text.match(/nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|league|champions|madrid|lakers|spread|sports|yankees|athletics|club|fc|atp|wta|sarasota|masters|tour|match|inning|over\/under|o\/u|win on 202|vs\.|vs /i);
    
    // Categorías sanas
    const isCrypto = text.match(/btc|eth|sol|crypto|bitcoin|ethereum|airdrop|token|etf|binance|memecoin|doge|pepe/i);
    const isPolitics = text.match(/election|president|trump|biden|senate|gop|dem|politics|party|vote|poll|debate/i);
    const isPop = text.match(/movie|oscar|grammy|mrbeast|box office|pop culture|youtube|tiktok|spotify|billboard/i);
    const isBusiness = text.match(/fed|interest rate|inflation|cpi|business|elon|tesla|openai|gdp|economy|apple|microsoft/i);

    // Si el filtro de deportes está APAGADO en el panel frontal, bloqueamos a la menor provocación
    if (isSports && !botStatus.marketFilters.sports) return false;
    
    if (isCrypto && !botStatus.marketFilters.crypto) return false;
    if (isPolitics && !botStatus.marketFilters.politics) return false;
    if (isPop && !botStatus.marketFilters.pop) return false;
    if (isBusiness && !botStatus.marketFilters.business) return false;

    // Si no encuentra nada, por seguridad lo dejamos pasar SOLO si no tiene el formato clásico de partido "Equipo A vs Equipo B"
    if (text.includes(" vs ") && !botStatus.marketFilters.sports) return false;

    return true; 
}

// === NUEVO MOTOR DE PERFILES DE RIESGO + REGLAS PERSONALIZADAS (Parche #8) ===
function getRiskProfile(marketName = "", isWhale = false) {
    const text = marketName.toLowerCase();
    
    // Detectar si es mercado volátil
    const isVolatile = /nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|league|champions|madrid|lakers|sports|pop|movie|oscar|grammy|temperature|temperatura/i.test(text);
    
    const profileType = isVolatile ? 'volatile' : 'standard';
    let config = isWhale ? botStatus.whaleConfig[profileType] : botStatus.aiConfig[profileType];

    // 🔥 NUEVO: Aplicar reglas personalizadas si existen
    const customRule = getCustomMarketRules(marketName);
    if (customRule) {
        config = { ...config, ...customRule };
    }

    return {
        config: config,
        profileType: profileType
    };
}

// ==========================================
// NUEVA FUNCIÓN: Reglas personalizadas por mercado (Parche #8 FINAL)
// ==========================================
function getCustomMarketRules(marketTitle = "") {
    if (!botStatus.customMarketRules || botStatus.customMarketRules.length === 0) {
        return null;
    }

    const titleLower = marketTitle.toLowerCase();

    for (const rule of botStatus.customMarketRules) {
        if (titleLower.includes(rule.keyword.toLowerCase())) {
            console.log(`📋 [CUSTOM RULE] Aplicada → ${marketTitle}`);
            return {
                takeProfitThreshold: rule.takeProfitThreshold,
                stopLossThreshold: rule.stopLossThreshold,
                microBetAmount: rule.microBetAmount   // ← NUEVO
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

        // 2. Copy-Trading (Auto + Custom) → NUEVA LÓGICA
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

        // ====================================================
        // 🧠 EJECUCIÓN MULTI-AGENTE (CLAUDE + GEMINI + GROK)
        // ====================================================
        const newsString = await getLatestNews(marketTitle, marketItem.category);
        const cacheKey = `${marketItem.tokenId}-${newsString.substring(0, 60)}`;

        let finalAnalysis;

        if (analysisCache.has(cacheKey)) {
            finalAnalysis = analysisCache.get(cacheKey);
        } else {
            console.log(`\n🤖 Analizando con la Trinidad: ${marketTitle.substring(0,45)}...`);

            const [claudeResult, geminiResult, grokResult] = await Promise.all([
                analyzeMarketWithClaude(marketTitle, newsString),
                analyzeMarketWithGemini(marketTitle, newsString),
                analyzeMarketWithGrok(marketTitle, newsString)
            ]);

            // === FUSIÓN DE OPINIONES (CONSENSO MÁS ESTRICTO) ===
            const claudeBuy = claudeResult.recommendation.includes("BUY");
            const geminiBuy = geminiResult.recommendation.includes("BUY");
            const grokBuy   = grokResult.recommendation.includes("BUY");

            const buyVotes = [claudeBuy, geminiBuy, grokBuy].filter(Boolean).length;

            finalAnalysis = { prob: 0, edge: 0, recommendation: "WAIT", reason: "", urgency: 5, engine: "None" };

            if (buyVotes >= 2) {
                console.log(`🔥 ¡CONSENSO FUERTE! (${buyVotes}/3 votos)`);
                
                const activeResults = [];
                let enginesStr = [];
                if (claudeBuy) { activeResults.push(claudeResult); enginesStr.push("C"); }
                if (geminiBuy) { activeResults.push(geminiResult); enginesStr.push("G"); }
                if (grokBuy)   { activeResults.push(grokResult);   enginesStr.push("X"); }

                finalAnalysis.prob = activeResults.reduce((sum, r) => sum + r.prob, 0) / buyVotes;
                finalAnalysis.edge = activeResults.reduce((sum, r) => sum + r.edge, 0) / buyVotes;
                finalAnalysis.urgency = Math.max(...activeResults.map(r => r.urgency));
                finalAnalysis.recommendation = "STRONG_BUY"; 
                finalAnalysis.reason = `[CONSENSO] ` + activeResults.map((r, i) => `${enginesStr[i]}: ${r.reason}`).join(" | ");
                finalAnalysis.engine = buyVotes === 3 ? "Trinity (C+G+X)" : `Consenso (${enginesStr.join('+')})`;

            } else if (claudeBuy) {
                finalAnalysis = { ...claudeResult, engine: "Claude" };
            } else if (geminiBuy) {
                finalAnalysis = { ...geminiResult, engine: "Gemini" };
            } else if (grokBuy) {
                finalAnalysis = { ...grokResult, engine: "Grok" };
            } else {
                finalAnalysis = { ...claudeResult, engine: "Claude" };
            }

            if (!claudeResult.isError && !geminiResult.isError && !grokResult.isError) {
                analysisCache.set(cacheKey, finalAnalysis);
                if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
            }
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

        const { config: profile, profileType } = getRiskProfile(marketTitle, false);

        const activeSportsCount = botStatus.activePositions.filter(p => p.category === 'SPORTS').length;
        const isSportsLimitReached = (marketItem.category === 'SPORTS' && 
                                     botStatus.maxActiveSportsMarkets > 0 && 
                                     activeSportsCount >= botStatus.maxActiveSportsMarkets);

        const isFlippedToNo = (targetSideLabel === "NO");

        // ====================== SEÑAL FUERTE (MÁS ESTRICTA) ======================
        const isStrongSignal = 
            (!alreadyInvested && !alreadyClosed && !alreadyPending && !isSportsLimitReached) && (
                (finalAnalysis.recommendation === "STRONG_BUY" && edge > 0.12) ||
                (finalAnalysis.recommendation === "BUY" && edge >= profile.edgeThreshold + 0.03 && 
                 targetProb >= profile.predictionThreshold + 0.05) ||
                (isFlippedToNo && targetProb >= profile.predictionThreshold + 0.05 && edge >= profile.edgeThreshold + 0.03) ||
                (finalAnalysis.urgency >= 9 && edge >= 0.11)
            );

        if (isSportsLimitReached) {
            console.log(`⚠️ [LIMITE] Omitiendo ${marketTitle} (límite de deportes alcanzado)`);
        }

        // ====================== EJECUCIÓN DEL SNIPER ======================
        if (botStatus.autoTradeEnabled && isStrongSignal) {
            const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
            
            // 🔥 NUEVO: Respeta microBetAmount de regla personalizada
            let dynamicBetAmount = profile.microBetAmount || 2.0;

            // Solo Kelly en edges excepcionales
            if (edge > 0.25 && livePrice > 0 && livePrice < 1) {
                const kellyFraction = edge / (1 - livePrice);
                dynamicBetAmount = Math.min(
                    saldoLibre * kellyFraction * 0.20,
                    4.0,                                 // ← subí un poco el tope máximo
                    profile.microBetAmount * 1.5
                );
            }

            dynamicBetAmount = Math.max(dynamicBetAmount, 0.5);   // nunca menos de $0.5
            dynamicBetAmount = Math.min(dynamicBetAmount, saldoLibre * 0.15);

            // Cooldown
            const lastTradeTime = botStatus.lastTrades[targetTokenId];
            if (lastTradeTime) {
                const minutesSince = (Date.now() - lastTradeTime) / 60000;
                if (minutesSince < botStatus.riskSettings.tradeCooldownMin) {
                    console.log(`⏳ COOLDOWN: Esperando ${Math.ceil(botStatus.riskSettings.tradeCooldownMin - minutesSince)}m`);
                    watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                    return; 
                }
            }

            console.log(`🎯 SNIPER DISPARO [${finalAnalysis.engine}] → [${targetSideLabel}] | Edge: ${(edge*100).toFixed(1)}% | Apuesta: $${dynamicBetAmount.toFixed(2)} ${profile.microBetAmount !== undefined ? '(regla personalizada)' : ''}`);

            const result = await executeTradeOnChain(
                marketItem.conditionId, 
                targetTokenId, 
                dynamicBetAmount, 
                livePrice, 
                marketItem.tickSize || "0.01"
            );

            if (result?.success) {
                pendingOrdersCache.add(targetTokenId); 
                
                await sendSniperAlert({
                    marketName: `${marketTitle} (Apuesta al ${targetSideLabel})`, 
                    probability: targetProb, 
                    marketPrice: livePrice,
                    edge: edge,
                    suggestedInversion: dynamicBetAmount, 
                    reasoning: finalAnalysis.reason
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
// AUTO SELL MANAGER - VERSIÓN FINAL MEJORADA (TP + SL Homologados)
// ==========================================
async function autoSellManager() {
    if (!botStatus.autoTradeEnabled) return;

    for (const pos of botStatus.activePositions) {
        if (pos.status && pos.status.includes('CANJEAR')) continue;

        const profit = pos.percentPnl || 0;
        const marketNameShort = (pos.marketName || "Mercado desconocido").substring(0, 45);

        let isWhaleTrade = botStatus.copiedPositions.some(cp => cp.tokenId === pos.tokenId);
        if (!isWhaleTrade) {
            isWhaleTrade = botStatus.copiedTrades.some(ct => ct.tokenId === pos.tokenId);
        }

        const { config: riskConfig, profileType } = getRiskProfile(pos.marketName, isWhaleTrade);
        const originTag = isWhaleTrade ? 'WHALE' : 'IA';

        console.log(`📊 [AUTO-SELL] ${originTag}-${profileType} | ${marketNameShort} | PnL: ${profit.toFixed(1)}%`);

        // ====================== TAKE PROFIT ======================
        if (profit >= riskConfig.takeProfitThreshold) {
            console.log(`📈 TAKE PROFIT EJECUTADO [${originTag}-${profileType}]: ${marketNameShort} (+${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, 
                    { httpsAgent: agent, timeout: 6500 });

                const bids = bookResp.data?.bids || [];
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                const bestPrice = parseFloat(bids[0].price);

                if (bestPrice <= 0.005) continue;

                const result = await executeSellOnChain(
                    pos.conditionId || null, 
                    pos.tokenId, 
                    sharesToSell, 
                    bestPrice, 
                    "0.01"
                );

                if (result?.success) {
                    closedPositionsCache.add(pos.tokenId);
                    
                    await updateRealBalances();

                    // 🔥 FIX: Cálculo real de Cartera Total
                    const metaMaskVal = parseFloat(botStatus.walletOnlyUSDC || 0);
                    const polyVal = parseFloat(botStatus.clobOnlyUSDC || 0);
                    const unclaimedVal = parseFloat(botStatus.unclaimedUSDC || 0);
                    const activePosValue = botStatus.activePositions.reduce((acc, p) => {
                        if (p.status && (p.status.includes('CANJEAR') || p.status.includes('PERDIDO'))) return acc;
                        return acc + parseFloat(p.currentValue || 0);
                    }, 0);

                    const carteraTotal = (metaMaskVal + polyVal + unclaimedVal + activePosValue).toFixed(2);

                    const alerta = `✅ *TAKE PROFIT EJECUTADO* ✅\n` +
                                `Origen: ${originTag} ${profileType}\n\n` +
                                `📈 Mercado: *${marketNameShort}*\n` +
                                `💰 Ganancia en este mercado: *+$${pos.cashPnl ? pos.cashPnl.toFixed(2) : '0.00'} (+${profit.toFixed(1)}%)*\n\n` +
                                `💰 *Cartera Total:* $${carteraTotal} USDC\n` +
                                `🟢 Disponible (Poly): *$${polyVal.toFixed(2)} USDC*\n` +
                                `🦊 MetaMask Wallet: *$${metaMaskVal.toFixed(2)} USDC*`;

                    await sendAlert(alerta);

                    if (isWhaleTrade) {
                        botStatus.copiedPositions = botStatus.copiedPositions.filter(p => p.tokenId !== pos.tokenId);
                    }
                }
            } catch (e) {
                console.error(`❌ Take Profit error:`, e.message);
            }
            continue;
        }

        // ====================== STOP LOSS ======================
        if (profit <= riskConfig.stopLossThreshold) {
            console.log(`🛑 STOP LOSS DETECTADO [${originTag}-${profileType}]: ${marketNameShort} (${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, 
                    { httpsAgent: agent, timeout: 6500 });

                const bids = bookResp.data?.bids || [];
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                let bestBidPrice = parseFloat(bids[0].price);

                if (bestBidPrice <= 0.001) bestBidPrice = 0.001;

                let worstPrice = bestBidPrice;
                let accumulated = 0;
                for (const bid of bids) {
                    accumulated += parseFloat(bid.size || 0);
                    worstPrice = parseFloat(bid.price);
                    if (accumulated >= sharesToSell) break;
                }

                const slippage = ((bestBidPrice - worstPrice) / bestBidPrice) * 100;
                const maxPanicSlippage = botStatus.riskSettings.panicSlippage || 40;

                if (slippage > maxPanicSlippage) {
                    worstPrice = bestBidPrice * (1 - (maxPanicSlippage / 100));
                }

                const result = await executeSellOnChain(
                    pos.conditionId || null, 
                    pos.tokenId, 
                    sharesToSell, 
                    worstPrice, 
                    "0.01"
                );

                if (result?.success) {
                    closedPositionsCache.add(pos.tokenId);
                    
                    await updateRealBalances();

                    // 🔥 FIX: Cálculo real de Cartera Total
                    const metaMaskVal = parseFloat(botStatus.walletOnlyUSDC || 0);
                    const polyVal = parseFloat(botStatus.clobOnlyUSDC || 0);
                    const unclaimedVal = parseFloat(botStatus.unclaimedUSDC || 0);
                    const activePosValue = botStatus.activePositions.reduce((acc, p) => {
                        if (p.status && (p.status.includes('CANJEAR') || p.status.includes('PERDIDO'))) return acc;
                        return acc + parseFloat(p.currentValue || 0);
                    }, 0);

                    const carteraTotal = (metaMaskVal + polyVal + unclaimedVal + activePosValue).toFixed(2);
                    const rescate = (sharesToSell * worstPrice).toFixed(2);

                    const alerta = `🛑 *STOP LOSS EJECUTADO*\n` +
                                   `Origen: ${originTag} ${profileType}\n\n` +
                                   `📉 Mercado: *${marketNameShort}*\n` +
                                   `💰 Pérdida en este mercado: *$${pos.cashPnl ? pos.cashPnl.toFixed(2) : '0.00'} (${profit.toFixed(1)}%)*\n` +
                                   `💸 Rescatado ≈ *$${rescate} USDC*\n\n` +
                                   `💰 *Cartera Total:* $${carteraTotal} USDC\n` +
                                   `🟢 Disponible (Poly): *$${polyVal.toFixed(2)} USDC*\n` +
                                   `🦊 MetaMask Wallet: *$${metaMaskVal.toFixed(2)} USDC*`;

                    await sendAlert(alerta);

                    if (isWhaleTrade) {
                        botStatus.copiedPositions = botStatus.copiedPositions.filter(p => p.tokenId !== pos.tokenId);
                    }
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
        console.log("🔄 [AUTO-REDEEM] Revisando TODAS las posiciones marcadas para canjear...");

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

        // Gas price dinámico con margen
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

                console.log(`✅ [REDEEM] Canjeado: ${pos.marketName?.substring(0, 50)}... (Valor original: $${pos.currentValue})`);

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
            console.log("ℹ️ [AUTO-REDEEM] No había posiciones marcadas para canjear");
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

// ENDPOINT DE PRUEBA RÁPIDA: http://localhost:3001/api/test-ukraine
app.get('/api/test-ukraine', async (req, res) => {
    const testData = {
        market: "Ukraine Security Guarantee Test",
        amount: 1, // 1 USDC
        conditionId: "0x2a6d2cb5250e55c9c910e2ce005cc67d956973fbffe9b69539fb4ab58383cc59",
        tokenId: "102029026340458291317949377120907354152193559123063951727024886400111944147071",
        marketPrice: 0.085
    };

    try {
        console.log(`\n🧪 [TEST BROWSER] Iniciando compra forzada de Ucrania...`);
        
        // Usamos directamente tu función de cadena (que ya tiene el SigType 2)
        const result = await executeTradeOnChain(
            testData.conditionId, 
            testData.tokenId, 
            testData.amount, 
            testData.marketPrice
        );

        if (result && result.success) {
            console.log("✅ ¡TEST EXITOSO! Orden enviada.");
            res.send(`<h1>🚀 Test Exitoso</h1><p>Orden ID: ${result.hash}</p>`);
        }
    } catch (e) {
        console.error("❌ Fallo en el Test:", e.message);
        res.status(500).send(`<h1>❌ Error de Firma</h1><p>${e.message}</p>`);
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

        if (botStatus.customWhales.length > 20) {
            return res.status(400).json({ 
                success: false, 
                error: "Máximo 20 ballenas custom permitidas" 
            });
        }

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

        if (!rules || !Array.isArray(rules)) {
            return res.status(400).json({ 
                success: false, 
                error: "Se esperaba un array de reglas" 
            });
        }

        // Limpiamos y validamos cada regla
        for (const rule of rules) {
            rule.keyword = (rule.keyword || "").trim();
            rule.takeProfitThreshold = parseInt(rule.takeProfitThreshold) || 25;
            rule.stopLossThreshold = parseInt(rule.stopLossThreshold) || -30;
            rule.microBetAmount = parseFloat(rule.microBetAmount) || 2.0;
        }

        // Reemplazamos completamente el array
        botStatus.customMarketRules = rules;

        saveConfigToDisk("Reglas personalizadas actualizadas (edición)");

        console.log(`📋 ${rules.length} reglas personalizadas guardadas correctamente`);

        res.json({ 
            success: true, 
            customMarketRules: botStatus.customMarketRules 
        });

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

    // 🔥 Reportes diarios automáticos (12:00 PM, 6:00 PM y 11:59 PM)
    scheduleDailyReports();

    // Arranque inicial controlado
    updateRealBalances().then(() => {
        runBot();   // Primera ejecución inmediata
    });
});