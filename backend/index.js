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

// 🛟 BOTÓN DE RESCATE (FUERA DE LA BÓVEDA)
app.get('/rescate', async (req, res) => {
    try {
        if (!clobClient) return res.send("Cliente CLOB no está listo.");
        await clobClient.cancelAll(); // Cancela todas las órdenes colgadas
        res.send("✅ Todas las órdenes fantasma fueron canceladas. Tus $4.30 han sido liberados.");
    } catch (e) {
        res.send("Error: " + e.message);
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
    copyTradingEnabled: false,
    useAutoWhales: true,
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
    customWhales: []
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
            copyTradingEnabled: botStatus.copyTradingEnabled,
            maxWhalesToCopy: botStatus.maxWhalesToCopy,
            maxActiveSportsMarkets: botStatus.maxActiveSportsMarkets,
            useAutoWhales: botStatus.useAutoWhales,
            customWhales: botStatus.customWhales
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2), 'utf8');
        console.log(`💾 Configuración guardada en el disco duro. (Origen: ${origen})`);
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

            // Carga directa y limpia de los nuevos objetos
            if (savedConfig.aiConfig) botStatus.aiConfig = savedConfig.aiConfig;
            if (savedConfig.whaleConfig) botStatus.whaleConfig = savedConfig.whaleConfig;
            if (savedConfig.marketFilters) botStatus.marketFilters = savedConfig.marketFilters;
            
            // Carga de variables sueltas
            if (savedConfig.autoTradeEnabled !== undefined) botStatus.autoTradeEnabled = savedConfig.autoTradeEnabled;
            if (savedConfig.copyTradingEnabled !== undefined) botStatus.copyTradingEnabled = savedConfig.copyTradingEnabled;
            if (savedConfig.maxWhalesToCopy !== undefined) botStatus.maxWhalesToCopy = savedConfig.maxWhalesToCopy;
            if (savedConfig.maxActiveSportsMarkets !== undefined) botStatus.maxActiveSportsMarkets = savedConfig.maxActiveSportsMarkets;
            if (savedConfig.useAutoWhales !== undefined) botStatus.useAutoWhales = savedConfig.useAutoWhales;
            if (savedConfig.customWhales !== undefined) botStatus.customWhales = savedConfig.customWhales;

            console.log("📂 Configuración cargada con éxito desde JSON limpio.");
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
            let totalUnclaimed = 0; // 🔥 NUEVO: Sumador de dinero por reclamar
            
            if (Array.isArray(positions) && positions.length > 0) {
                for (const pos of positions) {
                    const size = parseFloat(pos.size || pos['tamaño'] || 0);
                    
                    if (size < 0.1) continue; 

                    const cashPnl = parseFloat(pos.cashPnl || pos['ganancias en efectivo'] || 0);
                    const percentPnl = parseFloat(pos.percentPnl || pos['porcentaje de ganancias'] || 0);
                    const valorActual = parseFloat(pos.currentValue || pos.current_value || pos.value || 0);

                    const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                    // 🔥 FIX QUANT: Si es canjeable, lo sumamos a la bóveda de unclaimed y lo ocultamos de posiciones activas
                    if (isRedeemable) {
                        totalUnclaimed += valorActual;
                        if (!redeemedCache.has(pos.asset || pos.token_id)) {
                            redeemedCache.add(pos.asset || pos.token_id);
                        }
                        continue; 
                    }

                    botStatus.activePositions.push({
                        tokenId: pos.asset || pos.token_id || pos.asset_id,
                        conditionId: pos.conditionId || pos.condition_id,
                        size: size.toFixed(2),
                        exactSize: size,
                        marketName: pos.title || pos.market || pos['título'] || "Mercado Desconocido",
                        status: "ACTIVO 🟢",
                        currentValue: valorActual.toFixed(2),
                        cashPnl: cashPnl,
                        percentPnl: percentPnl,
                        category: getMarketCategoryEnhanced(pos.title || pos.market || pos['título'] || "")
                    });
                }
            }
            
            // Guardamos el total reclamable en el estado del bot
            botStatus.unclaimedUSDC = totalUnclaimed.toFixed(2);

        } catch (apiError) {
            console.log("⚠️ No se pudieron obtener posiciones:", apiError.message);
        }

        // 🔥 IMPRESIÓN DE BALANCES - Solo cada 4 ciclos (reduce spam)
        if (Math.random() < 0.25) {
            console.log(`📊 Balances: Wallet: $${botStatus.walletOnlyUSDC} | Polymarket: $${botStatus.clobOnlyUSDC} | Gas: ${botStatus.balancePOL} POL`);
        }

    } catch (e) { 
        console.error("❌ Error general actualizando balances:", e.message); 
    }
}

// ==========================================
// 3A. MOTOR DE IA 1 (CLAUDE)
// ==========================================
async function analyzeMarketWithClaude(marketQuestion, currentNews, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 180,
                system: `Eres un Senior Quant Trader especializado en Polymarket SHORT-TERM.
Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "WEATHER_EDGE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}`,
                messages: [{ role: "user", content: `Mercado: ${marketQuestion}\nNoticias: ${currentNews}\nAnaliza ventaja 24-48h.` }]
            });

            const jsonMatch = response.content[0].text.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("JSON inválido");
            const data = JSON.parse(jsonMatch[0]);

            return { isError: false, prob: parseFloat(data.prob) || 0, strategy: data.strategy || "WAIT", urgency: data.urgency || 5, reason: data.reason || "Sin ventaja", edge: parseFloat(data.edge) || 0, recommendation: data.recommendation || "WAIT" };

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
// 3B. MOTOR DE IA 2 (GEMINI)
// ==========================================
async function analyzeMarketWithGemini(marketQuestion, currentNews) {
    // Ya no es Fallback, es un proceso titular
    console.log("🧠 Gemini Short-Term Analysis...");
    
    try {
        const prompt = `Eres un Senior Quant Trader especializado en Polymarket SHORT-TERM (24-48 horas máximo).
Tu objetivo es detectar ineficiencias rápidas.

Responde ESTRICTAMENTE con este esquema JSON:
{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "WEATHER_EDGE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}

REGLAS:
- Prioriza mercados que se resuelvan en < 48h.
- Sé agresivo en short-term. Si no hay edge claro → "WAIT".

Mercado: ${marketQuestion}
Noticias recientes: ${currentNews}
Analiza si hay ventaja para operar en las próximas 24-48 horas.`;

        // 🚀 Ejecutamos el análisis
        const result = await geminiModel.generateContent(prompt);
        const responseText = result.response.text().trim();

        // 🛡️ Extracción segura por si incluye marcas de Markdown (```json ... ```)
        const jsonMatch = responseText.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("JSON inválido o respuesta vacía");

        const data = JSON.parse(jsonMatch[0]);

        return {
            isError: false,
            prob: parseFloat(data.prob) || 0,
            strategy: data.strategy || "WAIT",
            urgency: data.urgency || 5,
            reason: data.reason || "Sin ventaja clara", // Le quitamos el "[Gemini]" hardcodeado porque runBot ya lo maneja
            edge: parseFloat(data.edge) || 0,
            recommendation: data.recommendation || "WAIT"
        };

    } catch (error) {
        // Error aislado: No tumba el sistema, Claude puede seguir solo
        console.error("❌ Error en motor Gemini:", error.message);
        return { 
            isError: true, 
            prob: 0, 
            strategy: "WAIT", 
            urgency: 0, 
            reason: "Error Gemini en red/API", 
            edge: 0, 
            recommendation: "WAIT" 
        };
    }
}

// ==========================================
// 3C. MOTOR DE IA 3 (GROK / xAI)
// ==========================================
async function analyzeMarketWithGrok(marketQuestion, currentNews, retries = 2) {
    console.log("🧠 Grok Short-Term Analysis...");
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await grokClient.chat.completions.create({
                model: "grok-4-1-fast-non-reasoning", // Usamos el modelo más rápido y barato de xAI
                messages: [
                    {
                        role: "system",
                        content: `Eres un Quant Trader evaluando sentimiento social en tiempo real (X/Twitter).
Tu objetivo es detectar euforia o pánico rápido en Polymarket.
Responde ESTRICTAMENTE en JSON:
{
  "prob": 0.XX,
  "strategy": "MOMENTUM" | "NEWS_ARBITRAGE" | "WAIT",
  "urgency": 1-10,
  "reason": "Frase corta y clara del sentimiento",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}
REGLAS:
- Si no hay un hype o pánico evidente en redes, responde "WAIT".`
                    },
                    {
                        role: "user",
                        content: `Mercado: ${marketQuestion}\nNoticias recientes: ${currentNews}\nAnaliza si hay momentum en las próximas 24h.`
                    }
                ],
                response_format: { type: "json_object" } // xAI soporta JSON nativo
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
// 7. ACTUALIZACIÓN DE WATCHLIST (GAMMA API)
// ==========================================
async function refreshWatchlist() {
    try {
        botStatus.currentTopic = 'Buscando oportunidades rápidas (incluyendo 5m/15m)...';
        console.log(`\n⏰ [SNIPER] Escaneando mercados cortos y de alta frecuencia...`);

        const res = await axios.get(
            'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&dir=desc',
            { httpsAgent: agent }
        );

        const now = Date.now();

        const futureMarkets = res.data.filter(m => {
            if (!m.conditionId || !m.endDate) return false;
            
            const hoursLeft = hoursUntilClose(m.endDate);
            const volume = parseFloat(m.volume || 0);

            // ✅ Cambios clave:
            // - Bajamos el umbral de volumen para SHORT_TERM
            // - Aceptamos mercados que cierren en menos de 48h o tengan volumen decente
            return new Date(m.endDate).getTime() > now &&
                   (hoursLeft <= 48 || volume > 6000);   // antes era 8000
        });

        const targetedMarkets = futureMarkets.map(m => ({
            ...m,
            category: getMarketCategoryEnhanced(m.question)
        })).filter(m => m.category !== null);

        // Prioridad fuerte a mercados cortos
        targetedMarkets.sort((a, b) => {
            const hrsA = hoursUntilClose(a.endDate);
            const hrsB = hoursUntilClose(b.endDate);
            if (hrsA < 48 && hrsB >= 48) return -1;
            if (hrsB < 48 && hrsA >= 48) return 1;
            return parseFloat(b.volume || 0) - parseFloat(a.volume || 0);
        });

        const finalPool = [];
        const cats = ['SHORT_TERM', 'CRYPTO', 'GEOPOLITICS', 'SOCIAL'];
        let idx = 0;

        // Aumentamos el pool a 12-15 para tener más rotación
        while (finalPool.length < 14 && targetedMarkets.length > 0) {
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
                // Guardamos AMBOS tokens y AMBOS precios
                tokenYes: tokens[0] || null,
                tokenNo: tokens[1] || null,
                priceYes: parseFloat(prices[0] || 0),
                priceNo: parseFloat(prices[1] || 0),
                // Fallbacks para mantener compatibilidad con tu frontend
                tokenId: tokens[0] || null, 
                marketPrice: parseFloat(prices[0] || 0),
                endsIn: hrs < 1 ? `${Math.round(hrs*60)}m` : `${hrs.toFixed(1)}h`,
                tickSize: market.minimum_tick_size || "0.01",
                volume: parseFloat(market.volume || 0)
            };
        });

        botStatus.watchlist = rawTrends;
        console.log(`🎯 Pool seleccionado: ${rawTrends.length} mercados prioritarios (SHORT_TERM + otros)`);

    } catch (e) {
        console.error('❌ Error refreshWatchlist:', e.message);
    }
}

// ==========================================
// 8. EJECUCIÓN DE COMPRA (CORREGIDA)
// ==========================================
// Agregamos marketTickSize como parámetro (con "0.01" por defecto por seguridad)
async function executeTradeOnChain(conditionId, tokenId, amountUsdc, currentPrice, marketTickSize = "0.01") {
    try {
        console.log(`\n--- ⚖️ EJECUCIÓN ON-CHAIN EN POLYMARKET ---`);

        if (!clobClient) {
            throw new Error("clobClient no está inicializado.");
        }

        // 🛡️ 1. AUTO-LIMPIEZA DE FONDOS
        console.log("🧹 Liberando USDC de órdenes anteriores...");
        try { await clobClient.cancelAll(); } catch (e) {}

        // 🔍 2. OBTENER LA VERDAD ABSOLUTA DEL MERCADO (Tick Size y Neg Risk)
        let trueTickSize = "0.01";
        let isNegRisk = false; // Por defecto asumimos mercado normal
        
        try {
            // Le preguntamos al servidor central cómo está configurado este mercado
            const clobMarket = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
            if (clobMarket.data) {
                // 🚨 EL FIX MAESTRO: Detectamos si exige firma de Riesgo Negativo
                if (clobMarket.data.neg_risk === true) {
                    isNegRisk = true;
                }
                
                if (clobMarket.data.tokens) {
                    const tokenData = clobMarket.data.tokens.find(t => t.token_id === tokenId);
                    if (tokenData && tokenData.minimum_tick_size) {
                        trueTickSize = tokenData.minimum_tick_size;
                    }
                }
            }
        } catch (e) {
            trueTickSize = String(marketTickSize);
            console.log("⚠️ No se pudo verificar el servidor, usando valores base.");
        }
        
        const safeTickSize = String(trueTickSize);
        console.log(`✅ Parámetros CLOB -> Tick: ${safeTickSize} | NegRisk: ${isNegRisk}`);

        // 3. Ajuste de decimales y Precio Base
        const decimales = safeTickSize === "0.001" ? 3 : (safeTickSize === "0.0001" ? 4 : 2);
        const minPriceAllowed = parseFloat(safeTickSize);
        
        let basePrice = Number(parseFloat(currentPrice).toFixed(decimales));
        
        // 🛡️ ESCUDO ANTI-FANTASMAS
        if (basePrice < minPriceAllowed) {
            console.log(`⚠️ Mercado fantasma detectado (Precio: $${basePrice}). Ignorando disparo.`);
            return { success: false, error: "Precio por debajo del mínimo legal" };
        }

        // ⚡ LÓGICA PRO: SLIPPAGE (TOLERANCIA AL DESLIZAMIENTO)
        // Damos un margen de +2 ticks hacia arriba. 
        // El servidor siempre cobrará lo más barato, pero esto asegura la ejecución instantánea.
        let limitPrice = basePrice + (minPriceAllowed * 2);
        if (limitPrice > 0.99) limitPrice = 0.99; // Límite máximo legal absoluto
        limitPrice = Number(limitPrice.toFixed(decimales));

        // 4. Cálculo de munición (Calculamos usando el limitPrice para garantizar saldo suficiente)
        let numShares = Number((parseFloat(amountUsdc) / limitPrice).toFixed(2));
        
        if (numShares < 5) {
            console.log(`⚠️ Ajustando munición al mínimo requerido (5 shares)`);
            numShares = 5; 
        }
        
        if (numShares * limitPrice < 1) {
            numShares = Math.ceil(1.05 / limitPrice); 
            if (numShares < 5) numShares = 5;
        }

        numShares = Number(numShares.toFixed(2));

        console.log(`📡 Orden BUY: ${numShares} shares | Target: $${basePrice} | Max Tolerado: $${limitPrice}`);

        // 5. Disparo Final con opciones CAMALEÓNICAS
        const response = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: limitPrice, // <--- DISPARAMOS CON EL PRECIO BLINDADO (SLIPPAGE)
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
// 8.5 EJECUCIÓN DE VENTA (NUEVO MOTOR DEDICADO)
// ==========================================
// 🧠 Memoria a corto plazo para evitar Spam por retrasos de la API de Polymarket
const recentlySoldTokens = new Set();

async function executeSellOnChain(conditionId, tokenId, exactShares, limitPrice, marketTickSize = "0.01") {
    try {
        // 1. CANDADO ANTI-SPAM (COOLDOWN)
        if (recentlySoldTokens.has(tokenId)) {
            console.log(`      ⏳ Token en cooldown (Esperando actualización de API). Venta ignorada.`);
            return { success: false, reason: "COOLDOWN_ACTIVE" };
        }

        console.log(`\n--- 🔴 EJECUCIÓN DE VENTA ON-CHAIN ---`);
        if (!clobClient) throw new Error("clobClient no está inicializado.");

        // 2. OBTENER SALDO REAL DIRECTO DE LA BLOCKCHAIN
        let realBalance = 0;
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=50`);
            const positions = await response.json();
            
            if (Array.isArray(positions)) {
                const targetPos = positions.find(p => (p.asset === tokenId || p.token_id === tokenId));
                if (targetPos) {
                    realBalance = parseFloat(targetPos.size || targetPos['tamaño'] || 0);
                }
            }
        } catch (e) {
            console.log("⚠️ No se pudo obtener el saldo en tiempo real, usando la memoria del bot.");
        }

        // 3. CÁLCULO SEGURO DE SHARES
        let sharesToSell = parseFloat(exactShares);
        
        if (realBalance > 0 && sharesToSell > realBalance) {
            sharesToSell = realBalance;
        }

        // TRUCO QUANT: Restamos un margen microscópico (0.01 shares) para evadir los errores de "Not enough balance"
        sharesToSell = Math.max(0, sharesToSell - 0.01);
        sharesToSell = Math.floor(sharesToSell * 100) / 100;

        if (sharesToSell <= 0) {
           console.log(`⚠️ Venta abortada: Balance de acciones demasiado bajo (Polvo residual).`);
           recentlySoldTokens.add(tokenId); // Lo marcamos para ignorarlo y no hacer spam
           return { success: false, reason: "LOW_BALANCE" };
        }

        // 4. CONFIGURAR TICK SIZE Y PRECIO
        let trueTickSize = marketTickSize;
        let isNegRisk = false;

        try {
            const clobMarket = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
            if (clobMarket.data) {
                if (clobMarket.data.neg_risk === true) isNegRisk = true;
                if (clobMarket.data.tokens) {
                    const tokenData = clobMarket.data.tokens.find(t => t.token_id === tokenId);
                    if (tokenData && tokenData.minimum_tick_size) trueTickSize = tokenData.minimum_tick_size;
                }
            }
        } catch (e) {
            console.log("⚠️ No se pudo verificar el servidor para la venta, usando valores base.");
        }

        const decimales = trueTickSize === "0.001" ? 3 : (trueTickSize === "0.0001" ? 4 : 2);
        let safeLimitPrice = Number(parseFloat(limitPrice).toFixed(decimales));
        
        if (safeLimitPrice <= 0) safeLimitPrice = parseFloat(trueTickSize);

        console.log(`📡 Orden SELL: ${sharesToSell} shares | Target: $${safeLimitPrice} | NegRisk: ${isNegRisk}`);

        // 5. DISPARAR A LA BLOCKCHAIN
        const response = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: safeLimitPrice,
                side: Side.SELL,
                size: sharesToSell,
            },
            { 
                tickSize: String(trueTickSize), 
                negRisk: isNegRisk 
            }, 
            OrderType.GTC
        );

        if (response && response.success) {
            console.log(`🎉 ¡VENTA ACEPTADA! Order ID: ${response.orderID}`);
            
            // 🧠 ACTIVAR MEMORIA: Recordar que ya lo vendimos por 3 minutos
            recentlySoldTokens.add(tokenId);
            setTimeout(() => {
                recentlySoldTokens.delete(tokenId);
            }, 3 * 60 * 1000); // 3 minutos de cooldown
            
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
    if (!botStatus.copyTradingEnabled) return;

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
// CHECK AND COPY WHALE TRADES - VERSIÓN FINAL CORREGIDA (Auto + Custom)
// ==========================================
let isScanningWhales = false;

async function checkAndCopyWhaleTrades() {
    if (isScanningWhales) return;

    const hasActiveCopiedPositions = (botStatus.copiedPositions || []).length > 0;

    if (!botStatus.useAutoWhales && !botStatus.copyTradingEnabled && !hasActiveCopiedPositions) return;

    isScanningWhales = true;

    try {
        let allWhales = [];

        if (botStatus.useAutoWhales) {
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

        console.log(`🔄 [COPY-TRADING] Revisando trades de ${allWhales.length} ballenas (Auto + Custom)...`);

        for (const whale of allWhales) {
            try {
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

                    if (!tokenId || whaleSize < 500) continue;
                    if (Date.now() - timestamp > 15 * 60 * 1000) continue;

                    // ==================== COPIA DE COMPRA ====================
                    if (side === "BUY") {
                        if (botStatus.isPanicStopped) continue;
                        if (!isMarketAllowed(title)) continue;

                        if (botStatus.maxActiveSportsMarkets > 0 && botStatus.copiedPositions.length >= botStatus.maxActiveSportsMarkets) continue;

                        const alreadyHavePosition = botStatus.activePositions.some(p => p.tokenId === tokenId);
                        const alreadyCopied = botStatus.copiedTrades.some(t => t.txHash === txHash);
                        const alreadyPending = pendingOrdersCache.has(tokenId);

                        if (alreadyHavePosition || alreadyCopied || alreadyPending) continue;

                        // 🛡️ FIX QUANT 2: Le decimos al motor que SÍ es una ballena (true)
                        const { config: riskConfig } = getRiskProfile(title, true);
                        const currentBalance = parseFloat(botStatus.clobOnlyUSDC || 0);

                        // 🛡️ FIX QUANT 3: Lógica matemática restaurada para el límite de capital
                        const maxPct = riskConfig.maxCopyPercentOfBalance || 8; 
                        const maxAllowedPercent = currentBalance * (maxPct / 100);
                        
                        let montoInversion = Math.min(riskConfig.maxCopySize || 50, maxAllowedPercent);
                        if (montoInversion < 1) montoInversion = 1;

                        if (currentBalance < montoInversion) continue;

                        let limitPrice = price * 1.04;
                        if (limitPrice > 0.99) limitPrice = 0.99;

                        console.log(`🔥 [COPY BUY] ${whale.address.substring(0,8)}... → ${title.substring(0,45)}...`);

                        const result = await executeTradeOnChain(conditionId, tokenId, montoInversion, limitPrice, "0.01");

                        if (result?.success) {
                            pendingOrdersCache.add(tokenId);

                            botStatus.copiedTrades.unshift({
                                id: Date.now(),
                                txHash,
                                whale: whale.address.substring(0,10) + "...",
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
                                sizeCopied: montoInversion,
                                priceEntry: limitPrice,
                                marketName: title
                            });

                            botStatus.copyTradingStats.totalCopied = (botStatus.copyTradingStats.totalCopied || 0) + 1;
                            botStatus.copyTradingStats.successful = (botStatus.copyTradingStats.successful || 0) + 1;

                            await sendAlert(`🐋 *COPY BUY*\nMercado: ${title.substring(0,45)}...\nInversión: $${montoInversion.toFixed(2)}`);
                        }
                    }

                    // ==================== COPIA DE VENTA ====================
                    else if (side === "SELL") {
                        const copiedIndex = botStatus.copiedPositions.findIndex(p => 
                            p.tokenId === tokenId && p.whale === whale.address
                        );
                        if (copiedIndex === -1) continue;

                        const position = botStatus.copiedPositions[copiedIndex];
                        console.log(`🔥 [COPY SELL] Ballena vendió → Cerrando copia`);

                        let limitSellPrice = price * 0.97;
                        if (limitSellPrice < 0.01) limitSellPrice = 0.01;

                        const sellResult = await executeSellOnChain(conditionId, tokenId, position.sizeCopied, limitSellPrice, "0.01");

                        if (sellResult?.success) {
                            botStatus.copiedPositions.splice(copiedIndex, 1);
                            const rescateEst = (position.sizeCopied * limitSellPrice).toFixed(2);
                            await sendAlert(`🛑 *COPY SELL*\nMercado: ${title.substring(0,40)}...\nRescatado ≈ $${rescateEst} USDC`);
                        }
                    }
                }
            } catch (err) {
                if (!err.message.includes('429') && !err.message.includes('timeout')) {
                    console.error(`❌ Error whale ${whale.address.substring(0,8)}:`, err.message);
                }
            }
        }
    } finally {
        isScanningWhales = false;
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

// === NUEVO MOTOR DE PERFILES DE RIESGO ===
function getRiskProfile(marketName = "", isWhale = false) {
    const text = marketName.toLowerCase();
    
    // Grupo 2 (Volátil): Deportes y Pop
    const isVolatile = /nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|league|champions|madrid|lakers|sports|pop|movie|oscar|grammy|temperature|temperatura/i.test(text);
    
    const profileType = isVolatile ? 'volatile' : 'standard';
    return {
        config: isWhale ? botStatus.whaleConfig[profileType] : botStatus.aiConfig[profileType],
        profileType: profileType
    };
}

// ==========================================
// 10. CICLO PRINCIPAL (EL CEREBRO DEL BOT)
// ==========================================
let watchlistIndex = 0;

// ==========================================
// CICLO PRINCIPAL (MOTOR DEL BOT MULTI-AGENTE)
// ==========================================
async function runBot() {

    // 🚨 CANDADO DE PÁNICO (MODO SOLO CIERRE)
    if (botStatus.isPanicStopped) {
        console.log("🚨 [MODO PÁNICO] Compras bloqueadas. Ejecutando únicamente motor de ventas (TP/SL)...");
        try { await autoSellManager(); } catch (e) { console.log("Error autoSell:", e); }
        return; 
    }

    botStatus.lastCheck = new Date().toLocaleTimeString();

    try {
        // 1. Actualizaciones principales
        await fetchRealTrades();
        await updateRealBalances();

        // 2. Copy-Trading (Auto + Custom)
        if (botStatus.useAutoWhales || botStatus.copyTradingEnabled || 
            (botStatus.copiedPositions && botStatus.copiedPositions.length > 0)) {
            
            if (botStatus.useAutoWhales) {
                if (!botStatus.lastWhaleSelection || 
                    (Date.now() - new Date(botStatus.lastWhaleSelection).getTime()) > 10 * 60 * 1000) {
                    await autoSelectTopWhales();
                }
            }
            await checkAndCopyWhaleTrades();
        }

        await checkDailyLossLimit();
        await autoRedeemPositions();

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
        // 🧠 EJECUCIÓN MULTI-AGENTE (CLAUDE + GEMINI + GROK EN PARALELO)
        // ====================================================
        const newsString = await getLatestNews(marketTitle, marketItem.category);
        const cacheKey = `${marketItem.tokenId}-${newsString.substring(0, 60)}`;

        let finalAnalysis;

        if (analysisCache.has(cacheKey)) {
            finalAnalysis = analysisCache.get(cacheKey);
        } else {
            console.log(`\n🤖 Analizando con la Trinidad (Claude, Gemini, Grok): ${marketTitle.substring(0,40)}...`);
            
            const [claudeResult, geminiResult, grokResult] = await Promise.all([
                analyzeMarketWithClaude(marketTitle, newsString),
                analyzeMarketWithGemini(marketTitle, newsString),
                analyzeMarketWithGrok(marketTitle, newsString)
            ]);

            // === FUSIÓN DE OPINIONES (CONSENSO MAYORITARIO) ===
            const claudeBuy = claudeResult.recommendation.includes("BUY");
            const geminiBuy = geminiResult.recommendation.includes("BUY");
            const grokBuy = grokResult.recommendation.includes("BUY");

            const buyVotes = [claudeBuy, geminiBuy, grokBuy].filter(Boolean).length;

            finalAnalysis = { prob: 0, edge: 0, recommendation: "WAIT", reason: "", urgency: 5, engine: "None" };

            if (buyVotes >= 2) {
                console.log(`🔥 ¡CONSENSO LOGRADO! (${buyVotes}/3 votos para COMPRAR)`);
                
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
                
                if (buyVotes === 3) finalAnalysis.engine = "Trinity (C+G+X)";
                else finalAnalysis.engine = `Consenso (${enginesStr.join('+')})`;

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

        if (edgeNo > edgeYes && edgeNo > 0.03) {
            bestEdge = edgeNo;
            targetTokenId = marketItem.tokenNo;
            targetPrice = priceNo;
            targetProb = probNo;
            targetSideLabel = "NO";
        }

        const livePrice = targetPrice;
        const edge = bestEdge;

        // Filtros de Seguridad
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
        
        // 🛡️ FIX QUANT 1: Detectamos correctamente a la IA
        const { config: profile, profileType } = getRiskProfile(marketTitle, false);

        const activeSportsCount = botStatus.activePositions.filter(p => p.category === 'SPORTS').length;
        const sportsLimit = botStatus.maxActiveSportsMarkets;
        const isSportsLimitReached = (marketItem.category === 'SPORTS' && sportsLimit > 0 && activeSportsCount >= sportsLimit);
        const isFlippedToNo = (targetSideLabel === "NO");

        const isStrongSignal = 
            (!alreadyInvested && !alreadyClosed && !alreadyPending && !isSportsLimitReached) && (
                (finalAnalysis.recommendation === "STRONG_BUY" && edge > 0.105) ||
                (finalAnalysis.recommendation === "BUY" && edge >= profile.edgeThreshold && targetProb >= profile.predictionThreshold) ||
                (isFlippedToNo && targetProb >= profile.predictionThreshold && edge >= profile.edgeThreshold) ||
                (finalAnalysis.urgency >= 9 && edge >= Math.max(0.09, profile.edgeThreshold * 0.85))
            );

        if (isSportsLimitReached) {
            console.log(`⚠️ [LIMITE] Omitiendo ${marketTitle} porque ya tienes ${activeSportsCount} mercados de deportes abiertos.`);
        }

        let autoExecuted = false;

        // Ejecución del Sniper (IA principal)
        if (botStatus.autoTradeEnabled && isStrongSignal) {
            const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
            let dynamicBetAmount = profile.microBetAmount || 1.0; 

            if (edge > 0 && livePrice > 0 && livePrice < 1) {
                const kellyFraction = edge / (1 - livePrice);
                dynamicBetAmount = Math.min(saldoLibre * kellyFraction * 0.25, saldoLibre * 0.15, profile.microBetAmount * 3);
                dynamicBetAmount = Math.max(dynamicBetAmount, profile.microBetAmount);
            }

            console.log(`🎯 SNIPER DISPARO [${finalAnalysis.engine}] → [${targetSideLabel}] | Edge: ${(edge*100).toFixed(1)}%`);

            const result = await executeTradeOnChain(marketItem.conditionId, targetTokenId, dynamicBetAmount, livePrice, marketItem.tickSize || "0.01");

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
                autoExecuted = true;
            }
        }

        // === ACTUALIZAR DASHBOARD CON LA SEÑAL ===
        const signalIndex = botStatus.pendingSignals.findIndex(s => s.tokenId === targetTokenId);

        const signalData = {
            id: Date.now(),
            marketName: marketTitle,
            tokenId: targetTokenId,
            conditionId: marketItem.conditionId,
            probability: targetProb || 0,
            reasoning: finalAnalysis.reason || "Evaluado por IA",
            marketPrice: livePrice,
            suggestedInversion: profile.microBetAmount || 1.0, 
            edge: edge,
            urgency: finalAnalysis.urgency || 5,
            recommendation: finalAnalysis.recommendation || "WAIT",
            category: marketItem.category,
            side: targetSideLabel,
            profile: profileType,
            engine: finalAnalysis.engine
        };

        if (signalIndex === -1) {
            if (!autoExecuted) botStatus.pendingSignals.unshift(signalData);
            if (botStatus.pendingSignals.length > 12) botStatus.pendingSignals.pop();
        } else {
            botStatus.pendingSignals[signalIndex] = { ...botStatus.pendingSignals[signalIndex], ...signalData };
        }

        watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;

    } catch (error) {
        console.error('❌ Error en runBot:', error.message);
    }
}

// === AUTO SELL MANAGER MEJORADO ===
async function autoSellManager() {
    for (const pos of botStatus.activePositions) {
        if (pos.status && pos.status.includes('CANJEAR')) continue;

        const profit = pos.percentPnl || 0;
        const marketNameShort = (pos.marketName || "Mercado desconocido").substring(0, 45);

        // 👇 DETECTAMOS EL ORIGEN (IA o BALLENA) Y SU PERFIL
        const isWhaleTrade = botStatus.copiedPositions.some(cp => cp.tokenId === pos.tokenId);
        const { config: riskConfig, profileType } = getRiskProfile(pos.marketName, isWhaleTrade);

        // ====================== TAKE PROFIT ======================
        if (profit >= riskConfig.takeProfitThreshold) {
            console.log(`📈 TAKE PROFIT [${profileType}]: ${marketNameShort} (+${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, 
                    { httpsAgent: agent, timeout: 6500 });

                const bids = bookResp.data?.bids || [];
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                const bestPrice = parseFloat(bids[0].price);

                if (bestPrice <= 0.005) continue;   // protección ligera

                const result = await executeSellOnChain(
                    pos.conditionId || null, 
                    pos.tokenId, 
                    sharesToSell, 
                    bestPrice, 
                    "0.01"
                );

                if (result?.success) {
                    closedPositionsCache.add(pos.tokenId);
                    await sendAlert(`✅ *TAKE PROFIT [${profileType}]*\nMercado: ${marketNameShort}\nGanancia: +${profit.toFixed(1)}%`);
                    await updateRealBalances();
                }
            } catch (e) {
                console.error(`❌ Take Profit error:`, e.message);
            }
            continue;
        }

        // ====================== STOP LOSS ======================
        if (profit <= riskConfig.stopLossThreshold) {
            console.log(`🛑 STOP LOSS [${profileType}]: ${marketNameShort} (${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, 
                    { httpsAgent: agent, timeout: 6500 });

                const bids = bookResp.data?.bids || [];
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                if (sharesToSell <= 0) continue;

                const bestBidPrice = parseFloat(bids[0].price);

                if (bestBidPrice <= 0.005) {
                    console.log(`⚠️ Precio extremo. Manteniendo HOLD.`);
                    continue;
                }

                let accumulated = 0;
                let worstPrice = bestBidPrice;
                for (const bid of bids) {
                    accumulated += parseFloat(bid.size || 0);
                    worstPrice = parseFloat(bid.price);
                    if (accumulated >= sharesToSell) break;
                }

                const slippage = ((bestBidPrice - worstPrice) / bestBidPrice) * 100;
                if (slippage > 18) continue;

                const result = await executeSellOnChain(
                    pos.conditionId || null, 
                    pos.tokenId, 
                    sharesToSell, 
                    worstPrice, 
                    "0.01"
                );

                if (result?.success) {
                    closedPositionsCache.add(pos.tokenId);
                    const rescate = (sharesToSell * worstPrice).toFixed(2);
                    await sendAlert(
                        `🛑 *STOP LOSS [${profileType}]*\nMercado: ${marketNameShort}\nPnL: ${profit.toFixed(1)}%\nRescatado ≈ $${rescate} USDC`
                    );
                    await updateRealBalances();
                }
            } catch (e) {
                console.error(`❌ Stop Loss error:`, e.message);
            }
        }
    }
}

async function executeAutoSell(pos, profit, tipo) {
    try {
        const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
        if (sharesToSell <= 0) return;

        const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, 
            { httpsAgent: agent, timeout: 6000 });

        const bids = bookResp.data?.bids || [];
        if (bids.length === 0) return;

        const bestBidPrice = parseFloat(bids[0].price);
        const rescateEstimado = (sharesToSell * bestBidPrice).toFixed(2);

        try { await clobClient.cancelAll(); } catch (e) {}

        await clobClient.createAndPostOrder({
            tokenID: pos.tokenId,
            price: bestBidPrice,
            side: Side.SELL,
            size: sharesToSell
        });

        closedPositionsCache.add(pos.tokenId);

        await sendAlert(
            `${tipo === 'TOMA DE GANANCIAS' ? '📈' : '🛑'} *VENTA AUTOMÁTICA (${tipo})*\n` +
            `Mercado: ${pos.marketName}\n` +
            `PnL: ${profit.toFixed(1)}%\n` +
            `Rescatado ≈ $${rescateEstimado} USDC`
        );

        await updateRealBalances();

    } catch (e) {
        console.error("Error en executeAutoSell:", e.message);
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
// AUTO-REDEEM (Reclamar ganancias automáticamente)
// ==========================================
async function autoRedeemPositions() {
    if (!botStatus.autoRedeemEnabled) return;

    const redeemable = botStatus.activePositions.filter(p => 
        p.status && p.status.includes('CANJEAR')
    );

    if (redeemable.length === 0) return;

    console.log(`♻️ [AUTO-REDEEM] Encontradas ${redeemable.length} posiciones listas para canjear...`);

    for (const pos of redeemable) {
        try {
            console.log(`   ♻️ Canjeando: ${pos.marketName} (${pos.size} shares)`);
            // Aquí iría la llamada real al redeem cuando tengamos el método
            // Por ahora solo log y quitamos del array
            await sendAlert(`♻️ *AUTO-REDEEM*\n${pos.marketName}\n${pos.size} shares canjeadas`);

            // Removemos del array de posiciones activas
            botStatus.activePositions = botStatus.activePositions.filter(p => p.tokenId !== pos.tokenId);
        } catch (e) {
            console.error(`Error en auto-redeem de ${pos.tokenId}:`, e.message);
        }
    }
}

// ==========================================
// DAILY LOSS LIMIT (Stop-loss global del día)
// ==========================================
async function checkDailyLossLimit() {
    if (!botStatus.copyTradingEnabled && !botStatus.autoTradeEnabled) return;

    try {
        // 🔥 FIX QUANT: Calcular valor real de la cartera (Efectivo + Posiciones vivas)
        let activePortfolioValue = 0;
        if (botStatus.activePositions && botStatus.activePositions.length > 0) {
            activePortfolioValue = botStatus.activePositions.reduce((acc, pos) => {
                return !pos.status.includes('CANJEAR') ? acc + parseFloat(pos.currentValue || 0) : acc;
            }, 0);
        }

        const totalCurrentValue = parseFloat(botStatus.clobOnlyUSDC || 0) + activePortfolioValue;

        // Guardamos el balance inicial del día si es el primer chequeo (o si se reseteó a 0)
        if (botStatus.dailyStartBalance === 0) {
            botStatus.dailyStartBalance = totalCurrentValue;
        }

        const dailyPnL = totalCurrentValue - botStatus.dailyStartBalance;
        botStatus.dailyPnL = dailyPnL;

        const lossPercent = botStatus.dailyStartBalance > 0 
            ? (dailyPnL / botStatus.dailyStartBalance) * 100 
            : 0;

        // Si se supera el límite de pérdida real -> Panic Stop
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

// 3. Toggle Copy-Trading + Top Whales
app.post('/api/settings/copytrading', (req, res) => {
    const { enabled, maxWhalesToCopy } = req.body;
    
    if (enabled !== undefined) botStatus.copyTradingEnabled = !!enabled;
    
    if (maxWhalesToCopy !== undefined) {
        botStatus.maxWhalesToCopy = parseInt(maxWhalesToCopy) || 5;
        botStatus.lastWhaleSelection = null; // Forzamos a que busque nuevas ballenas
    }
    
    saveConfigToDisk("API CopyTrading Toggle");
    res.json({ success: true, copyTradingEnabled: botStatus.copyTradingEnabled });
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
        const { maxActiveSportsMarkets } = req.body;
        
        if (maxActiveSportsMarkets !== undefined) {
            // Actualizamos la memoria RAM del bot
            botStatus.maxActiveSportsMarkets = parseInt(maxActiveSportsMarkets);
            
            // Guardamos permanentemente en el bot_config.json
            saveConfigToDisk("API Configuración Límite Deportes");
            
            res.json({ success: true, message: "Límite de deportes actualizado" });
        } else {
            res.status(400).json({ success: false, error: "Parámetros incompletos" });
        }
    } catch (error) {
        console.error("❌ Error en /api/settings/config:", error);
        res.status(500).json({ success: false, error: "Error interno del servidor" });
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

        if (botStatus.customWhales.length > 10) {
            return res.status(400).json({ 
                success: false, 
                error: "Máximo 10 ballenas custom permitidas" 
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
// 11. INICIO DEL MOTOR DEL SNIPER
// ==========================================
app.listen(PORT, async () => {
    console.log(`\n======================================================`);
    console.log(`🎯 POLY-SNIPER V2: SERVIDOR ACTIVO EN PUERTO ${PORT}`);
    console.log(`======================================================\n`);
    
    // 🔥 DISPARAMOS EL AUTO-SELECTOR ANTES DE ARRANCAR EL BOT
    await initGemini();

    // 🟢 RELOJES MAESTROS DE IA Y PORTAFOLIO
    setInterval(runBot, 60000);            // Escanear IA cada 1 minuto
    setInterval(monitorPortfolio, 180000); // Vigilar ganancias cada 3 minutos
    
    // 🔥 RELOJ ULTRA-RÁPIDO INDEPENDIENTE (COPY TRADING)
    setInterval(checkAndCopyWhaleTrades, 10000); 

    // 🛡️ NUEVO: RELOJ GUARDIÁN DEL SERVIDOR
    setInterval(monitorSystemHealth, 60000); // Revisa RAM y CPU cada 1 minuto

    // Arranque inicial controlado
    updateRealBalances().then(() => {
        runBot();
    });
});