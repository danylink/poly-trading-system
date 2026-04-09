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

const agent = new https.Agent({  
    rejectUnauthorized: false 
});

dotenv.config();

// 👇 INICIALIZAR GEMINI (Global)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

// Declaramos el modelo con la configuración JSON estricta
const geminiModel = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    generationConfig: {
        responseMimeType: "application/json"
    }
});

// --- CONFIGURACIÓN DE IA Y DASHBOARD ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
app.use(cors());
app.use(express.json());
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

// --- ESTADO GLOBAL DEL SNIPER ---
let botStatus = {
    lastCheck: null,
    lastProbability: 0,
    currentMarket: { title: "Iniciando escáner...", title_es: "Iniciando escáner..." }, 
    currentTopic: "Inicializando radares...",
    watchlist: [],
    lastNews: [], 
    balanceUSDC: "0.00",      // Este será el que use el bot para cálculos
    walletOnlyUSDC: "0.00",   // <--- NUEVO: Solo lo que hay en MetaMask
    clobOnlyUSDC: "0.00",     // <--- NUEVO: Solo lo que hay en Polymarket
    balancePOL: "0.00",
    activePositions: [],
    executions: [], 
    pendingSignals: [], 
    isPanicStopped: false,
    predictionThreshold: 0.70,
    edgeThreshold: 0.09,
    takeProfitThreshold: 18,
    autoTradeEnabled: true,
    microBetAmount: 1.00,
    suggestedInversion: 0, 
    potentialROI: 0,
    copyTradingEnabled: true,
    maxCopySize: 50,                    // ← Máximo shares a copiar por trade
    maxCopyPercentOfBalance: 8,         // ← Máximo % del balance por copia (8%)
    dailyLossLimit: 10,                   // ← Nuevo: Stop-loss diario en %
    dailyPnL: 0,                          // ← Nuevo: PnL acumulado del día
    dailyStartBalance: 0,                 // ← Nuevo: Balance al inicio del día
    autoRedeemEnabled: true,              // ← Nuevo: Auto-redeem activado
    autoSelectedWhales: [],        // ← wallets que el bot elige automáticamente
    maxWhalesToCopy: 10,            // cuántas ballenas copiar (1 a 5)
    lastWhaleSelection: null,
    copiedTrades: [],
    copiedPositions: [],
    copyTradingStats: { totalCopied: 0, successful: 0 }
};

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
/*
async function updateRealBalances() {
    try {
        // 1. Balance de Gas (POL)
        const polBal = await provider.getBalance(wallet.address);
        botStatus.balancePOL = Number(ethers.utils.formatEther(polBal)).toFixed(3);

        // 2. Balance USDC en MetaMask (Billetera Personal)
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
            
            console.log(`📊 Balances: Wallet: $${botStatus.walletOnlyUSDC} | Polymarket: $${botStatus.clobOnlyUSDC} | Gas: ${botStatus.balancePOL} POL`);
        }
        // --- 4. OBTENER POSICIONES ACTIVAS (VÍA DATA API Y PROXY WALLET) ---
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS; 
            
            if (!userAddress) {
                console.log("⚠️ Advertencia: POLY_PROXY_ADDRESS no está definido en el archivo .env");
                return;
            }

            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=50`);
            const positions = await response.json();
            
            botStatus.activePositions = []; 
            
            if (Array.isArray(positions) && positions.length > 0) {
                for (const pos of positions) {

                    const size = parseFloat(pos.size || pos['tamaño'] || 0);
                    const cashPnl = parseFloat(pos.cashPnl || pos['ganancias en efectivo'] || 0);
                    const percentPnl = parseFloat(pos.percentPnl || pos['porcentaje de ganancias'] || 0);
                    const valorActual = parseFloat(pos.currentValue || pos.current_value || pos.value || pos['valor actual'] || 0);

                    if (size > 0) {
                        const nombreMercado = pos.title || pos.market || pos['título'] || "Mercado Desconocido";
                        const tokenId = pos.asset || pos.token_id || pos.asset_id;
                        const conditionId = pos.conditionId || pos.condition_id;
                        const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                        // 🧹 LÓGICA DE AUTO-CANJE Y LIMPIEZA VISUAL
                        if (isRedeemable) {
                            // Si es la primera vez que vemos que terminó, mandamos alerta de cierre
                            if (!redeemedCache.has(tokenId)) {
                                console.log(`♻️ AUTO-CANJE: Limpiando mercado finalizado -> ${nombreMercado}`);
                                const resultado = cashPnl >= 0 ? `Ganancia: +$${cashPnl.toFixed(2)}` : `Pérdida: -$${Math.abs(cashPnl).toFixed(2)}`;
                                
                                // Mandamos el recibo a Telegram (sin await para no frenar el ciclo)
                                // sendAlert(`🗑️ *POSICIÓN ARCHIVADA (AUTO-CANJE)*\nMercado: ${nombreMercado}\nResultado: ${resultado}\n\nLa posición ha sido removida de la tabla en vivo.`);
                                
                                // Lo guardamos en memoria para no volver a alertar
                                redeemedCache.add(tokenId);
                            }
                            
                            // 🚀 IMPORTANTE: Saltamos esta iteración. Al no hacer el push, 
                            // la tarjeta simplemente desaparece de tu Dashboard.
                            continue; 
                        }

                        // Si el mercado sigue vivo, lo mandamos al Dashboard
                        botStatus.activePositions.push({
                            tokenId: tokenId,
                            conditionId: conditionId,
                            size: size.toFixed(2),
                            exactSize: size,
                            marketName: nombreMercado,
                            status: "ACTIVO 🟢", // Ya es seguro dejarlo siempre en ACTIVO
                            currentValue: valorActual.toFixed(2),
                            cashPnl: cashPnl,        
                            percentPnl: percentPnl   
                        });
                    }
                }
            }
            
        } catch (apiError) {
             console.log("⚠️ No se pudieron obtener las posiciones de la Data API:", apiError.message);
        }

    } catch (e) { 
        console.error("❌ Error general actualizando balances:", e.message); 
    }
}
*/
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
            
            if (Array.isArray(positions) && positions.length > 0) {
                for (const pos of positions) {
                    const size = parseFloat(pos.size || pos['tamaño'] || 0);
                    if (size <= 0) continue;

                    const cashPnl = parseFloat(pos.cashPnl || pos['ganancias en efectivo'] || 0);
                    const percentPnl = parseFloat(pos.percentPnl || pos['porcentaje de ganancias'] || 0);
                    const valorActual = parseFloat(pos.currentValue || pos.current_value || pos.value || 0);

                    const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                    if (isRedeemable) {
                        if (!redeemedCache.has(pos.asset || pos.token_id)) {
                            redeemedCache.add(pos.asset || pos.token_id);
                        }
                        continue; // No mostramos posiciones ya finalizadas
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
                        percentPnl: percentPnl
                    });
                }
            }
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
// 3. ANÁLISIS DE IA (CLAUDE)
// ==========================================
// async function analyzeMarketWithClaude(marketQuestion, currentNews) {
//     console.log("🧠 Consultando a Claude (Análisis de Mercado)...");
//     try {
//         const response = await anthropic.messages.create({
//             model: "claude-sonnet-4-6", // Versión actual recomendada por Anthropic
//             max_tokens: 150,
//             system: `Eres un Senior Quant Trader especializado en Polymarket. 
//             Tu objetivo es encontrar ineficiencias entre las noticias y el precio del mercado.

//             Responde ESTRICTAMENTE en JSON con esta estructura:
//             {
//             "prob": 0.XX,
//             "strategy": "MOMENTUM" | "ARBITRAGE" | "TIME_EDGE" | "REVERSAL",
//             "urgency": 1-10,
//             "reason": "Frase corta de por qué hay ventaja aquí",
//             "searchQuery": "3-4 palabras clave para el contrato"
//             }

//             GUÍAS DE ESTRATEGIA:
//             - TIME_EDGE: El evento es casi inevitable y el mercado aún no llega a 0.95+.
//             - ARBITRAGE: La noticia confirma el resultado pero el precio se mueve lento.
//             - REVERSAL: El mercado entró en pánico por un rumor que el análisis de noticias desmiente.
//             - MOMENTUM: La noticia es masiva y el precio va a subir rápido en los próximos minutos.`,
//             messages: [{
//                 role: "user",
//                 content: `Noticia: ${marketQuestion}. \nContexto: ${currentNews}. \nAnaliza la probabilidad de este mercado.`
//             }]
//         });

//         const jsonMatch = response.content[0].text.match(/\{.*\}/s); 
//         if (!jsonMatch) throw new Error("Formato JSON inválido de Claude");

//         const data = JSON.parse(jsonMatch[0]);
//         return {
//             prob: parseFloat(data.prob) || 0,
//             reason: data.reason || "Sin descripción.",
//             searchQuery: data.searchQuery || marketQuestion
//         };
//     } catch (error) {
//         console.error("❌ Error en Claude:", error.message);
//         return { prob: 0, reason: "Error de IA", searchQuery: marketQuestion };
//     }
// }

/*
async function analyzeMarketWithClaude(marketQuestion, currentNews) {
    console.log("🧠 Claude Short-Term Analysis...");

    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 180,
            system: `Eres un Senior Quant Trader especializado en Polymarket SHORT-TERM (24-48 horas máximo).

Tu objetivo es detectar ineficiencias rápidas.

Responde **ESTRICTAMENTE** en JSON:

{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "WEATHER_EDGE",
  "urgency": 1-10,
  "reason": "Frase corta y clara",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}

REGLAS:
- Prioriza mercados que se resuelvan en < 48h.
- TIME_EDGE: Resultado casi inevitable y mercado barato.
- MOMENTUM: Noticia masiva que moverá precio en horas.
- NEWS_ARBITRAGE: Noticia ya salió pero precio no reaccionó.
- WEATHER_EDGE: Mercados de clima con datos oficiales.
- Sé agresivo en short-term. Si no hay edge claro → "WAIT".`,

            messages: [{
                role: "user",
                content: `Mercado: ${marketQuestion}\n\nNoticias recientes: ${currentNews}\n\nAnaliza si hay ventaja para operar en las próximas 24-48 horas.`
            }]
        });

        const jsonMatch = response.content[0].text.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("JSON inválido");

        const data = JSON.parse(jsonMatch[0]);

        return {
            prob: parseFloat(data.prob) || 0,
            strategy: data.strategy || "WAIT",
            urgency: data.urgency || 5,
            reason: data.reason || "Sin ventaja clara",
            edge: parseFloat(data.edge) || 0,
            recommendation: data.recommendation || "WAIT"
        };

    } catch (error) {
        console.error("❌ Error Claude:", error.message);
        return { prob: 0, strategy: "WAIT", urgency: 0, reason: "Error IA", edge: 0, recommendation: "WAIT" };
    }
}
*/

async function analyzeMarketWithClaude(marketQuestion, currentNews, retries = 2) {
    console.log("🧠 Claude Short-Term Analysis...");

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 180,
                system: `Eres un Senior Quant Trader especializado en Polymarket SHORT-TERM (24-48 horas máximo).

Tu objetivo es detectar ineficiencias rápidas.

Responde **ESTRICTAMENTE** en JSON:

{
  "prob": 0.XX,
  "strategy": "TIME_EDGE" | "MOMENTUM" | "NEWS_ARBITRAGE" | "REVERSAL" | "WEATHER_EDGE",
  "urgency": 1-10,
  "reason": "Frase corta y clara",
  "edge": 0.XX,
  "recommendation": "STRONG_BUY" | "BUY" | "WAIT" | "SELL"
}

REGLAS:
- Prioriza mercados que se resuelvan en < 48h.
- TIME_EDGE: Resultado casi inevitable y mercado barato.
- MOMENTUM: Noticia masiva que moverá precio en horas.
- NEWS_ARBITRAGE: Noticia ya salió pero precio no reaccionó.
- WEATHER_EDGE: Mercados de clima con datos oficiales.
- Sé agresivo en short-term. Si no hay edge claro → "WAIT".`,
                messages: [{
                    role: "user",
                    content: `Mercado: ${marketQuestion}\n\nNoticias recientes: ${currentNews}\n\nAnaliza si hay ventaja para operar en las próximas 24-48 horas.`
                }]
            });

            const jsonMatch = response.content[0].text.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("JSON inválido");

            const data = JSON.parse(jsonMatch[0]);

            return {
                isError: false, // 🟢 Bandera de éxito
                prob: parseFloat(data.prob) || 0,
                strategy: data.strategy || "WAIT",
                urgency: data.urgency || 5,
                reason: data.reason || "Sin ventaja clara",
                edge: parseFloat(data.edge) || 0,
                recommendation: data.recommendation || "WAIT"
            };

        } catch (error) {
            const isOverloaded = error.status === 529 || error.status === 429 || error.message.includes('Overloaded');
            
            if (isOverloaded && attempt < retries) {
                console.log(`⚠️ Claude saturado (Error ${error.status}). Intento ${attempt} de ${retries}. Esperando 3 segundos...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue; 
            }

            console.error("❌ Error Claude persistente:", error.message);
            
            // 👇 ¡EL SISTEMA DE REDUNDANCIA ENTRA EN ACCIÓN!
            // Si Claude falla definitivamente, llamamos a Gemini para no perder la oportunidad
            return await analyzeMarketWithGemini(marketQuestion, currentNews);
        }
    }
}

async function analyzeMarketWithGemini(marketQuestion, currentNews) {
    console.log("⚡ [FALLBACK] Claude falló. Activando motor Gemini 1.5 Flash...");
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
        
        // Extraemos el texto directamente (SIN el await)
        const responseText = result.response.text().trim();

        // 🛡️ Extracción segura por si incluye marcas de Markdown (```json ... ```)
        const jsonMatch = responseText.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("JSON inválido");

        const data = JSON.parse(jsonMatch[0]);

        return {
            isError: false,
            prob: parseFloat(data.prob) || 0,
            strategy: data.strategy || "WAIT",
            urgency: data.urgency || 5,
            reason: `[Gemini] ${data.reason || "Sin ventaja clara"}`, 
            edge: parseFloat(data.edge) || 0,
            recommendation: data.recommendation || "WAIT"
        };

    } catch (error) {
        console.error("❌ Error Fatal en Ambos Motores (Claude y Gemini):", error.message);
        return { isError: true, prob: 0, strategy: "WAIT", urgency: 0, reason: "Error IA Total", edge: 0, recommendation: "WAIT" };
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

    // Mercados de alta frecuencia (los que dan dinero rápido)
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

    return null;
}

// ==========================================
// 7. ACTUALIZACIÓN DE WATCHLIST (GAMMA API)
// ==========================================

// async function refreshWatchlist() {
//     try {
//         botStatus.currentTopic = 'Escaneando Mercados de Alta Probabilidad...';
//         console.log(`\n⏰ [SNIPER] Escaneando 500 mercados en busca de ineficiencias...`);

//         const agent = new https.Agent({ rejectUnauthorized: false });
//         // Añadimos parámetros de ordenamiento por volumen directamente en la API
//         const polyRes = await axios.get(
//             'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&dir=desc',
//             { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0' } }
//         );

//         if (!polyRes.data || polyRes.data.length === 0) throw new Error('No mercados devueltos');

//         const now = Date.now();
        
//         // 1. Filtro de Calidad: Debe tener conditionId, fecha futura y VOLUMEN MÍNIMO ($5k)
//         const futureMarkets = polyRes.data.filter(m => {
//             const hasData = m.conditionId && m.endDate && m.clobTokenIds;
//             const isFuture = new Date(m.endDate).getTime() > now;
//             const hasLiquidity = parseFloat(m.volume || 0) > 5000; 
//             return hasData && isFuture && hasLiquidity;
//         });

//         // 2. Clasificación por tus 3 Pilares
//         const targetedMarkets = futureMarkets.map(m => ({ 
//             ...m, 
//             category: getMarketCategory(m.question) 
//         })).filter(m => m.category !== null);

//         // 3. El "Mix" del Sniper: Priorizar lo que cierra pronto
//         targetedMarkets.sort((a, b) => {
//             const hrsA = hoursUntilClose(a.endDate);
//             const hrsB = hoursUntilClose(b.endDate);
            
//             // Prioridad máxima a lo que cierra en < 12h (Time-Edge)
//             if (hrsA < 12 && hrsB >= 12) return -1;
//             if (hrsB < 12 && hrsA >= 12) return 1;
            
//             // Si ambos son pronto o ambos son tarde, decidir por volumen
//             return parseFloat(b.volume || 0) - parseFloat(a.volume || 0);
//         });

//         const finalPool = [];
//         const cats = ['CRYPTO', 'GEOPOLITICS', 'SOCIAL'];
//         let idx = 0;
        
//         // Aseguramos diversidad en el pool de 4 slots
//         while (finalPool.length < 4 && targetedMarkets.length > 0) {
//             const desiredCat = cats[idx % cats.length];
//             const matchIdx = targetedMarkets.findIndex(m => m.category === desiredCat);
//             if (matchIdx !== -1) {
//                 finalPool.push(targetedMarkets[matchIdx]);
//                 targetedMarkets.splice(matchIdx, 1);
//             } else if (targetedMarkets.length > 0) {
//                 finalPool.push(targetedMarkets[0]);
//                 targetedMarkets.splice(0, 1);
//             }
//             idx++;
//         }

//         console.log(`🎯 Pool de Combate: ${finalPool.length} objetivos detectados.`);

//         const rawTrends = [];
//         for (const market of finalPool) {
//             const hrs = hoursUntilClose(market.endDate);
//             const hrsLabel = hrs < 1 ? `${Math.round(hrs * 60)}m` : hrs < 24 ? `${hrs.toFixed(1)}h` : `${Math.ceil(hrs / 24)}d`;
//             const tickSize = market.minimum_tick_size || "0.01";
            
//             let currentPrice = null;
//             try { currentPrice = parseFloat(JSON.parse(market.outcomePrices)[0]); } catch(e){}

//             let clobTokenId = null;
//             try { clobTokenId = JSON.parse(market.clobTokenIds)[0]; } catch(e){}

//             rawTrends.push({
//                 title: market.question,
//                 title_es: "Esperando análisis de Claude...",
//                 category: market.category,
//                 conditionId: market.conditionId,
//                 tokenId: clobTokenId,
//                 isTradeable: true,
//                 endDate: market.endDate,
//                 endsIn: hrsLabel,
//                 marketPrice: currentPrice,
//                 tickSize: tickSize,
//                 volume: parseFloat(market.volume).toLocaleString()
//             });
//             console.log(`📡 [${market.category}] $${currentPrice || '?' } | Vol: $${parseFloat(market.volume).toFixed(0)} | Q: "${market.question.substring(0, 35)}..."`);
//         }

//         botStatus.watchlist = rawTrends;
//     } catch (e) { console.error('❌ Error Sniper Watchlist:', e.message); }
// }
// async function refreshWatchlist() {
//     try {
//         botStatus.currentTopic = 'Buscando oportunidades 24-48h...';
//         console.log(`\n⏰ [SNIPER] Escaneando mercados cortos...`);

//         const res = await axios.get(
//             'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&dir=desc',
//             { httpsAgent: agent }
//         );

//         const now = Date.now();

//         const futureMarkets = res.data.filter(m => {
//             const hoursLeft = hoursUntilClose(m.endDate);
//             return m.conditionId && 
//                    m.endDate && 
//                    new Date(m.endDate).getTime() > now &&
//                    (hoursLeft <= 48 || parseFloat(m.volume || 0) > 8000);
//         });

//         const targetedMarkets = futureMarkets.map(m => ({
//             ...m,
//             category: getMarketCategoryEnhanced(m.question)
//         })).filter(m => m.category !== null);

//         // Prioridad fuerte a mercados cortos
//         targetedMarkets.sort((a, b) => {
//             const hrsA = hoursUntilClose(a.endDate);
//             const hrsB = hoursUntilClose(b.endDate);
//             if (hrsA < 48 && hrsB >= 48) return -1;
//             if (hrsB < 48 && hrsA >= 48) return 1;
//             return parseFloat(b.volume || 0) - parseFloat(a.volume || 0);
//         });

//         const finalPool = [];
//         const cats = ['SHORT_TERM', 'CRYPTO', 'GEOPOLITICS', 'SOCIAL'];
//         let idx = 0;

//         while (finalPool.length < 10 && targetedMarkets.length > 0) {
//             const cat = cats[idx % cats.length];
//             const match = targetedMarkets.findIndex(m => m.category === cat);
//             if (match !== -1) {
//                 finalPool.push(targetedMarkets[match]);
//                 targetedMarkets.splice(match, 1);
//             } else if (targetedMarkets.length > 0) {
//                 finalPool.push(targetedMarkets.shift());
//             }
//             idx++;
//         }

//         const rawTrends = finalPool.map(market => {
//             const hrs = hoursUntilClose(market.endDate);
//             return {
//                 title: market.question,
//                 category: market.category,
//                 conditionId: market.conditionId,
//                 tokenId: JSON.parse(market.clobTokenIds || "[]")[0],
//                 marketPrice: parseFloat(JSON.parse(market.outcomePrices || "[]")[0] || 0),
//                 endsIn: hrs < 1 ? `${Math.round(hrs*60)}m` : `${hrs.toFixed(1)}h`,
//                 tickSize: market.minimum_tick_size || "0.01",
//                 volume: parseFloat(market.volume || 0)
//             };
//         });

//         botStatus.watchlist = rawTrends;
//         console.log(`🎯 Pool seleccionado: ${rawTrends.length} mercados prioritarios`);

//     } catch (e) {
//         console.error('❌ Error refreshWatchlist:', e.message);
//     }
// }
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
// 9. Función para recuperar trades reales
// ==========================================
/*
async function fetchRealTrades() {
    const PROXY_WALLET = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
    try {
        console.log("📡 Sincronizando historial de transacciones nativo...");
        
        const response = await axios.get(
            `https://data-api.polymarket.com/trades?user=${PROXY_WALLET}&limit=15`, 
            { httpsAgent: agent }
        );

        const rawTrades = response.data.data || response.data.trades || response.data;

        if (Array.isArray(rawTrades) && rawTrades.length > 0) {
            botStatus.executions = await Promise.all(rawTrades.map(async (trade) => {
                const hash = trade.transactionHash || trade.transaction_hash || trade.id || "0x00000000";
                const title = trade.title || "Mercado Polymarket";
                const tokenId = trade.asset || trade.asset_id || trade.token_id;
                
                const side = (trade.side || "BUY").toUpperCase();
                const shares = parseFloat(trade.size || 0);
                const tradePrice = parseFloat(trade.price || 0);
                const transactionValue = shares * tradePrice; 

                // 💎 EXTRACCIÓN DE DATOS ESTILO POLYMARKET
                const outcomeStr = trade.outcome || "Yes"; 
                const priceCents = Math.round(tradePrice * 100); 

                const timestampMs = trade.timestamp ? (String(trade.timestamp).length === 10 ? parseInt(trade.timestamp) * 1000 : parseInt(trade.timestamp)) : Date.now();

                let estadoOperacion = "";
                let currentPrice = 0;

                if (side === "SELL") {
                    estadoOperacion = "Vendido"; // Venta exitosa
                } else {
                    try {
                        const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, { httpsAgent: agent });
                        if (bookResp.data?.bids?.length > 0) {
                            currentPrice = parseFloat(bookResp.data.bids[0].price);
                        } else {
                            const priceResp = await axios.get(`https://clob.polymarket.com/price?token_id=${tokenId}`, { httpsAgent: agent });
                            currentPrice = parseFloat(priceResp.data.price || 0);
                        }
                    } catch (e) { currentPrice = 0; }

                    if (currentPrice === 0) {
                        estadoOperacion = "Perdido"; // Compró y el mercado expiró en cero
                    } else {
                        estadoOperacion = "Comprado"; // Compró y el mercado sigue vivo
                    }
                }

                return {
                    id: hash.substring(0, 10),
                    tokenId: tokenId,
                    time: new Date(timestampMs).toLocaleTimeString(),
                    market: title,               // <--- SIN TRUNCAR (Texto completo)
                    outcome: outcomeStr,         // <--- Ej: "No", "Yes", "Over"
                    priceCents: priceCents,      // <--- Ej: 53
                    shares: shares.toFixed(1),   // <--- Ej: 12.6
                    side: side,
                    inversion: transactionValue, // El dinero que se movió
                    status: estadoOperacion      // Vendido, Comprado, Perdido
                };
            }));
        }
    } catch (e) {
        console.error("❌ Error actualizando trades:", e.message);
    }
}
*/

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
// ==========================================
// AUTO COPY-TRADING - SELECCIÓN AUTOMÁTICA DE WHALES (VERSIÓN CORREGIDA)
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

/*
async function checkAndCopyWhaleTrades() {
    if (!botStatus.copyTradingEnabled || botStatus.autoSelectedWhales.length === 0) return;

    console.log(`🔄 [COPY-TRADING] Revisando trades (BUY + SELL) de ${botStatus.autoSelectedWhales.length} whales...`);

    for (const whale of botStatus.autoSelectedWhales) {
        try {
            const response = await axios.get(
                `https://data-api.polymarket.com/trades?user=${whale.address}&limit=15`,
                { httpsAgent: agent, timeout: 10000 }
            );

            const recentTrades = response.data.data || response.data.trades || [];

            for (const trade of recentTrades) {
                if (!trade) continue;

                const side = (trade.side || "").toUpperCase();
                const tokenId = trade.asset;
                const size = parseFloat(trade.size || 0);
                const price = parseFloat(trade.price || 0);
                const timestamp = parseInt(trade.timestamp || 0) * 1000;
                const title = trade.title || "Mercado desconocido";

                if (!tokenId || size < 5) continue;
                if (Date.now() - timestamp > 20 * 60 * 1000) continue; // últimos 20 minutos

                // ==================== COPIA DE COMPRA ====================
                if (side === "BUY") {
                    const alreadyCopied = botStatus.copiedTrades.some(t => t.tokenId === tokenId);
                    if (alreadyCopied) continue;

                    console.log(`      🔥 [COPY BUY] Whale ${whale.address.substring(0,8)}... compró ${size.toFixed(1)} @ $${price.toFixed(3)}`);

                    const result = await executeTradeOnChain(null, tokenId, botStatus.microBetAmount, price, "0.01");

                    if (result?.success) {
                        botStatus.copiedTrades.unshift({ id: Date.now(), whale: whale.address.substring(0,10)+"..", tokenId, size, price, time: new Date().toLocaleTimeString() });
                        botStatus.copiedPositions.push({ tokenId, whale: whale.address, sizeCopied: botStatus.microBetAmount, priceEntry: price });
                        console.log(`      ✅ Copia BUY ejecutada`);
                    }
                }

                // ==================== COPIA DE VENTA ====================
                else if (side === "SELL") {
                    // Buscamos si nosotros tenemos una posición copiada de esta whale
                    const copiedIndex = botStatus.copiedPositions.findIndex(p => 
                        p.tokenId === tokenId && p.whale === whale.address
                    );

                    if (copiedIndex === -1) continue; // no es una posición que copiamos

                    const position = botStatus.copiedPositions[copiedIndex];

                    console.log(`      🔥 [COPY SELL] Whale ${whale.address.substring(0,8)}... vendió → Vendiendo nuestra posición`);

                    // Vendemos lo que nosotros tenemos
                    const sellResult = await executeTradeOnChain(null, tokenId, position.sizeCopied, price * 0.98, "0.01"); // vendemos un poco más barato para asegurar

                    if (sellResult?.success) {
                        console.log(`      ✅ COPY SELL ejecutado exitosamente`);
                        botStatus.copiedPositions.splice(copiedIndex, 1); // eliminamos la posición copiada
                    }
                }
            }
        } catch (err) {
            console.error(`      ❌ Error whale ${whale.address.substring(0,8)}...:`, err.message);
        }
    }
}
*/
async function checkAndCopyWhaleTrades() {
    if (!botStatus.copyTradingEnabled || botStatus.autoSelectedWhales.length === 0) return;

    console.log(`🔄 [COPY-TRADING] Revisando trades (BUY + SELL) de ${botStatus.autoSelectedWhales.length} whales...`);

    let totalDetected = 0;

    for (const whale of botStatus.autoSelectedWhales) {
        try {
            const response = await axios.get(
                `https://data-api.polymarket.com/trades?user=${whale.address}&limit=15`,
                { httpsAgent: agent, timeout: 10000 }
            );

            const recentTrades = response.data.data || response.data.trades || [];

            for (const trade of recentTrades) {
                if (!trade) continue;

                const side = (trade.side || "").toUpperCase();
                const tokenId = trade.asset;
                const size = parseFloat(trade.size || 0);
                const price = parseFloat(trade.price || 0);
                const timestamp = parseInt(trade.timestamp || 0) * 1000;
                const title = trade.title || "Mercado desconocido";

                if (!tokenId || size < 5) continue;
                if (Date.now() - timestamp > 20 * 60 * 1000) continue; // últimos 20 min

                // ==================== COPIA DE COMPRA ====================
                if (side === "BUY") {
                    // === MEJORA CLAVE: Validación anti-duplicados más fuerte ===
                    const alreadyHavePosition = botStatus.activePositions.some(p => p.tokenId === tokenId);
                    const alreadyCopiedRecently = botStatus.copiedTrades.some(t => 
                        t.tokenId === tokenId && (Date.now() - t.id) < 10 * 60 * 1000
                    );

                    if (alreadyHavePosition || alreadyCopiedRecently) {
                        console.log(`      ⏭️  Ya tenemos posición o copia reciente de: ${title.substring(0,50)}...`);
                        continue;
                    }

                    // Filtros de tamaño y % de balance
                    if (size > botStatus.maxCopySize) {
                        console.log(`      ⏭️ Trade demasiado grande (${size} shares). Ignorando.`);
                        continue;
                    }

                    const currentBalance = parseFloat(botStatus.clobOnlyUSDC || 0);
                    const maxAllowed = currentBalance * (botStatus.maxCopyPercentOfBalance / 100);
                    if (botStatus.microBetAmount > maxAllowed) {
                        console.log(`      ⏭️ Copia supera % máximo del balance. Ignorando.`);
                        continue;
                    }

                    console.log(`      🔥 [COPY BUY] Whale compró ${size.toFixed(1)} @ $${price.toFixed(3)} → ${title.substring(0,55)}...`);

                    const result = await executeTradeOnChain(null, tokenId, botStatus.microBetAmount, price, "0.01");

                    if (result?.success) {
                        botStatus.copiedTrades.unshift({
                            id: Date.now(),
                            whale: whale.address.substring(0,10) + "...",
                            tokenId,
                            size: botStatus.microBetAmount,
                            price,
                            time: new Date().toLocaleTimeString(),
                            market: title
                        });

                        botStatus.copiedPositions.push({
                            tokenId,
                            whale: whale.address,
                            sizeCopied: botStatus.microBetAmount,
                            priceEntry: price,
                            marketName: title
                        });

                        botStatus.copyTradingStats.totalCopied++;
                        botStatus.copyTradingStats.successful++;
                    }
                }

                // ==================== COPIA DE VENTA ====================
                else if (side === "SELL") {
                    const copiedIndex = botStatus.copiedPositions.findIndex(p => p.tokenId === tokenId && p.whale === whale.address);
                    if (copiedIndex === -1) continue;

                    const position = botStatus.copiedPositions[copiedIndex];

                    console.log(`      🔥 [COPY SELL] Whale vendió → Vendiendo nuestra posición`);

                    const sellResult = await executeTradeOnChain(null, tokenId, position.sizeCopied, price * 0.97, "0.01");

                    if (sellResult?.success) {
                        console.log(`      ✅ COPY SELL ejecutado`);
                        botStatus.copiedPositions.splice(copiedIndex, 1);
                        botStatus.copyTradingStats.totalSold++;
                    }
                }
            }
        } catch (err) {
            console.error(`      ❌ Error whale ${whale.address.substring(0,8)}...:`, err.message);
        }
    }

    if (totalDetected === 0) {
        console.log("   ℹ️  No se detectaron compras/ventas nuevas de whales en este ciclo.");
    }
}

// ==========================================
// 10. CICLO PRINCIPAL (EL CEREBRO DEL BOT)
// ==========================================
let watchlistIndex = 0;

/*
async function runBot() {
    if (botStatus.isPanicStopped) return;

    botStatus.lastCheck = new Date().toLocaleTimeString();

    try {
        await fetchRealTrades();
        await updateRealBalances();

        // Copy-Trading + Controles de Riesgo
        if (botStatus.copyTradingEnabled) {
            if (!botStatus.lastWhaleSelection || 
                (Date.now() - new Date(botStatus.lastWhaleSelection).getTime()) > 10 * 60 * 1000) {
                await autoSelectTopWhales();
            }
            await checkAndCopyWhaleTrades();
        }

        // Controles de riesgo
        await checkDailyLossLimit();
        await autoRedeemPositions();

        if (botStatus.autoTradeEnabled) {
            await autoSellManager();
        }

        // Refrescar watchlist cuando sea necesario
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

        const newsString = await getLatestNews(marketTitle, marketItem.category);
        const cacheKey = `${marketItem.tokenId}-${newsString.substring(0, 60)}`;

        let analysis;
        if (analysisCache.has(cacheKey)) {
            analysis = analysisCache.get(cacheKey);
        } else {
            analysis = await analyzeMarketWithClaude(marketTitle, newsString);
            
            // 🛡️ ESCUDO ANTI-CACHÉ BASURA
            if (analysis.isError) {
                console.log(`⏭️ Claude falló al analizar. Saltando [${marketTitle}] temporalmente para no envenenar la caché.`);
                watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                return; // Cortamos el ciclo aquí. En un minuto lo volverá a intentar limpio.
            }

            // Si todo salió bien, ahora sí guardamos en caché
            analysisCache.set(cacheKey, analysis);
            if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
        }

        // 👇 ¡EL FIX! Le pasamos el dato de Claude a tu panel frontal
        botStatus.lastProbability = analysis.prob || 0;
        
        // ==========================================
        // 🧠 LÓGICA BIDIRECCIONAL (EL MOTOR QUANT)
        // ==========================================
        const probYes = analysis.prob || 0;
        const probNo = 1 - probYes; // Matemática inversa perfecta
        
        const priceYes = marketItem.priceYes || 0;
        const priceNo = marketItem.priceNo || 0;
        
        const edgeYes = priceYes > 0 ? probYes - priceYes : 0;
        const edgeNo = priceNo > 0 ? probNo - priceNo : 0;

        // ⚖️ TOMA DE DECISIÓN: ¿Cuál es nuestra mejor jugada?
        let bestEdge = 0;
        let targetTokenId = marketItem.tokenYes;
        let targetPrice = priceYes;
        let targetProb = probYes;
        let targetSideLabel = "SÍ";

        // Si el "NO" tiene un Edge superior al "SÍ" y es positivo, cambiamos de arma
        if (edgeNo > edgeYes && edgeNo > 0.02) {
            bestEdge = edgeNo;
            targetTokenId = marketItem.tokenNo;
            targetPrice = priceNo;
            targetProb = probNo;
            targetSideLabel = "NO";
        } else {
            bestEdge = edgeYes;
            targetTokenId = marketItem.tokenYes;
            targetPrice = priceYes;
            targetProb = probYes;
            targetSideLabel = "SÍ";
        }

        const livePrice = targetPrice;
        const edge = bestEdge;
        let autoExecuted = false;

        // ==========================================
        // 🛡️ FILTRO QUANT: Escudo Anti-Lotería (Penny Stocks)
        // ==========================================
        // Evitamos comprar cosas extremadamente baratas (< $0.05) donde no hay liquidez 
        // y cualquier movimiento a la baja nos liquida al -100%.
        // Evitamos comprar cosas extremadamente caras (> $0.85) donde el ROI es pésimo.
        if (livePrice < 0.05 || livePrice > 0.85) {
            console.log(`⏭️ Ignorando mercado: Precio ($${livePrice}) fuera de la zona segura. Jugada al [${targetSideLabel}] abortada.`);
            watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
            return; // Cortamos la ejecución aquí, saltando al siguiente mercado
        }

        // 🛡️ NUEVO BLINDAJE 2.0: Evaluamos el token ESPECÍFICO (Sí o No)
        const alreadyInvested = botStatus.activePositions.some(pos => pos.tokenId === targetTokenId);
        const alreadyClosed = typeof closedPositionsCache !== 'undefined' ? closedPositionsCache.has(targetTokenId) : false;

        // 🔥 LÓGICA DE DISPARO CORREGIDA (Usando el targetProb y targetSide)
        const isStrongSignal = 
            (!alreadyInvested && !alreadyClosed) && ( 
                (analysis.recommendation === "STRONG_BUY" && edge > 0.02) ||
                (analysis.recommendation === "BUY" && edge >= botStatus.edgeThreshold && targetProb >= botStatus.predictionThreshold) ||
                (analysis.urgency >= 8 && edge >= Math.max(0.04, botStatus.edgeThreshold * 0.65)) ||
                (marketItem.category === "SHORT_TERM" && edge >= 0.045 && targetProb >= 0.57)
            );

        // 🧠 CRITERIO DE KELLY (Gestión Dinámica de Capital)
        const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || botStatus.balanceUSDC) || 0;
        let dynamicBetAmount = botStatus.microBetAmount; 

        if (edge > 0 && livePrice > 0 && livePrice < 1) {
            const kellyFraction = edge / (1 - livePrice);
            const kellyMultiplier = 0.25; 
            let calculatedBet = saldoLibre * kellyFraction * kellyMultiplier;

            const minBet = botStatus.microBetAmount; 
            const maxBet = saldoLibre * 0.15;        

            if (calculatedBet < minBet) calculatedBet = minBet;
            if (calculatedBet > maxBet) calculatedBet = maxBet;

            dynamicBetAmount = Number(calculatedBet.toFixed(2));
        }

        // ⚡ EJECUCIÓN DEL DISPARO
        if (botStatus.autoTradeEnabled && isStrongSignal) {
            console.log(`🎯 SNIPER DISPARO DETECTADO → Jugada al [${targetSideLabel}] | Edge: ${(edge*100).toFixed(1)}% | Prob: ${(targetProb*100).toFixed(0)}%`);
            
            if (saldoLibre < 1) {
                console.log("⚠️ Autopilot: Saldo insuficiente para ejecutar disparo.");
            } else {
                console.log(`🧠 Kelly Mode -> Disparo Ajustado: $${dynamicBetAmount} USDC`);

                const result = await executeTradeOnChain(
                    marketItem.conditionId,
                    targetTokenId, // <--- USAMOS EL TOKEN DEL LADO GANADOR
                    dynamicBetAmount, 
                    livePrice,
                    marketItem.tickSize || "0.01"
                );

                if (result?.success) {
                    console.log(`✅ ¡COMPRA AUTOMÁTICA EJECUTADA (${targetSideLabel})!`);

                    await sendSniperAlert({
                        marketName: `${marketTitle} (Apuesta al ${targetSideLabel})`, // Modificamos el título para Telegram
                        probability: targetProb, // Mandamos la prob del lado que operamos
                        marketPrice: livePrice,
                        edge: edge,
                        suggestedInversion: dynamicBetAmount, 
                        reasoning: analysis.reason
                    });

                    autoExecuted = true;
                }
            }
        }

        // === ACTUALIZACIÓN DE SEÑALES PARA EL DASHBOARD ===
        const signalIndex = botStatus.pendingSignals.findIndex(s => s.tokenId === targetTokenId);

        const signalData = {
            id: Date.now(),
            marketName: marketTitle, // 🧹 LIMPIEZA: Quitamos el "[Jugada: X]" para que el dashboard se vea premium y limpio
            tokenId: targetTokenId,
            conditionId: marketItem.conditionId,
            probability: targetProb || 0,
            reasoning: analysis.reason || "Evaluado por Claude",
            marketPrice: livePrice,
            suggestedInversion: dynamicBetAmount,
            edge: edge,
            urgency: analysis.urgency || 5,
            recommendation: analysis.recommendation || "WAIT",
            category: marketItem.category,
            side: targetSideLabel // Opcional: Mandamos el lado como variable interna por si tu Frontend lo necesita luego
        };

        if (signalIndex === -1) {
            if (!autoExecuted) botStatus.pendingSignals.unshift(signalData);
            if (botStatus.pendingSignals.length > 12) botStatus.pendingSignals.pop();
        } else {
            botStatus.pendingSignals[signalIndex] = { 
                ...botStatus.pendingSignals[signalIndex], 
                ...signalData 
            };
        }

        watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;

    } catch (error) {
        console.error('❌ Error en runBot:', error.message);
    }
}
*/
async function runBot() {
    if (botStatus.isPanicStopped) return;

    botStatus.lastCheck = new Date().toLocaleTimeString();

    try {
        // Actualizaciones principales
        await fetchRealTrades();
        await updateRealBalances();

        // Copy-Trading + Controles de Riesgo
        if (botStatus.copyTradingEnabled) {
            if (!botStatus.lastWhaleSelection || 
                (Date.now() - new Date(botStatus.lastWhaleSelection).getTime()) > 10 * 60 * 1000) {
                await autoSelectTopWhales();
            }
            await checkAndCopyWhaleTrades();
        }

        await checkDailyLossLimit();
        await autoRedeemPositions();

        if (botStatus.autoTradeEnabled) {
            await autoSellManager();
        }

        // Refresh Watchlist solo cuando sea necesario
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

        const newsString = await getLatestNews(marketTitle, marketItem.category);
        const cacheKey = `${marketItem.tokenId}-${newsString.substring(0, 60)}`;

        let analysis;
        if (analysisCache.has(cacheKey)) {
            analysis = analysisCache.get(cacheKey);
        } else {
            analysis = await analyzeMarketWithClaude(marketTitle, newsString);
            
            if (analysis.isError) {
                console.log(`⏭️ Claude falló. Saltando mercado temporalmente.`);
                watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                return;
            }

            analysisCache.set(cacheKey, analysis);
            if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
        }

        botStatus.lastProbability = analysis.prob || 0;

        // === LÓGICA BIDIRECCIONAL (Sí / No) ===
        const probYes = analysis.prob || 0;
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

        if (edgeNo > edgeYes && edgeNo > 0.02) {
            bestEdge = edgeNo;
            targetTokenId = marketItem.tokenNo;
            targetPrice = priceNo;
            targetProb = probNo;
            targetSideLabel = "NO";
        }

        const livePrice = targetPrice;
        const edge = bestEdge;

        // Filtro anti-penny stocks y anti-precios extremos
        if (livePrice < 0.05 || livePrice > 0.85) {
            console.log(`⏭️ Ignorando mercado: Precio ($${livePrice}) fuera de zona segura.`);
            watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
            return;
        }

        const alreadyInvested = botStatus.activePositions.some(pos => pos.tokenId === targetTokenId);
        const alreadyClosed = closedPositionsCache.has(targetTokenId);

        const isStrongSignal = 
            (!alreadyInvested && !alreadyClosed) && (
                (analysis.recommendation === "STRONG_BUY" && edge > 0.08) ||
                (analysis.recommendation === "BUY" && edge >= botStatus.edgeThreshold && targetProb >= botStatus.predictionThreshold) ||
                (analysis.urgency >= 9 && edge >= 0.07) ||                    // más exigente
                (marketItem.category === "SHORT_TERM" && edge >= 0.095 && targetProb >= 0.68)  // más exigente
            );

        let autoExecuted = false;

        if (botStatus.autoTradeEnabled && isStrongSignal) {
            const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
            let dynamicBetAmount = botStatus.microBetAmount;

            if (edge > 0 && livePrice > 0 && livePrice < 1) {
                const kellyFraction = edge / (1 - livePrice);
                dynamicBetAmount = Math.min(
                    saldoLibre * kellyFraction * 0.25,
                    saldoLibre * 0.15,
                    botStatus.microBetAmount * 3
                );
                dynamicBetAmount = Math.max(dynamicBetAmount, botStatus.microBetAmount);
            }

            console.log(`🎯 SNIPER DISPARO → [${targetSideLabel}] | Edge: ${(edge*100).toFixed(1)}% | Prob: ${(targetProb*100).toFixed(0)}%`);

            const result = await executeTradeOnChain(
                marketItem.conditionId,
                targetTokenId,
                dynamicBetAmount,
                livePrice,
                marketItem.tickSize || "0.01"
            );

            if (result?.success) {
                console.log(`✅ ¡COMPRA AUTOMÁTICA EJECUTADA (${targetSideLabel})!`);
                await sendSniperAlert({
                    marketName: `${marketTitle} (Apuesta al ${targetSideLabel})`,
                    probability: targetProb,
                    marketPrice: livePrice,
                    edge: edge,
                    suggestedInversion: dynamicBetAmount,
                    reasoning: analysis.reason
                });
                autoExecuted = true;
            }
        }

        // Actualizar señales para dashboard
        const signalIndex = botStatus.pendingSignals.findIndex(s => s.tokenId === targetTokenId);

        const signalData = {
            id: Date.now(),
            marketName: marketTitle,
            tokenId: targetTokenId,
            conditionId: marketItem.conditionId,
            probability: targetProb || 0,
            reasoning: analysis.reason || "Evaluado por Claude",
            marketPrice: livePrice,
            suggestedInversion: botStatus.microBetAmount,
            edge: edge,
            urgency: analysis.urgency || 5,
            recommendation: analysis.recommendation || "WAIT",
            category: marketItem.category,
            side: targetSideLabel
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

async function autoSellManager() {
    for (const pos of botStatus.activePositions) {
        // Ignorar posiciones ya finalizadas o listas para canjear
        if (pos.status && pos.status.includes('CANJEAR')) continue;

        const profit = pos.percentPnl || 0;
        const marketNameShort = (pos.marketName || "Mercado desconocido").substring(0, 45);

        // =============================================
        // 1. TAKE PROFIT (18% o más)
        // =============================================
        if (profit >= botStatus.takeProfitThreshold) {
            console.log(`📈 TAKE PROFIT DETECTADO: ${marketNameShort} (+${profit.toFixed(1)}%)`);

            await executeAutoSell(pos, profit, 'TOMA DE GANANCIAS');
            continue;
        }

        // =============================================
        // 2. STOP LOSS (más paciente)
        // =============================================
        if (profit <= -15) {   // ← Recomendado: -15% (antes estabas vendiendo muy rápido)
            
            console.log(`🛑 EVALUANDO STOP LOSS: ${marketNameShort} (${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(
                    `https://clob.polymarket.com/book?token_id=${pos.tokenId}`, 
                    { httpsAgent: agent, timeout: 6500 }
                );

                const bids = bookResp.data?.bids || [];

                if (bids.length === 0) {
                    console.log(`⚠️ No hay compradores para ${marketNameShort}. Esperando...`);
                    continue;
                }

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                if (sharesToSell <= 0) continue;

                const bestBidPrice = parseFloat(bids[0].price);

                // Calculamos slippage aproximado barriendo el libro
                let accumulated = 0;
                let worstPrice = bestBidPrice;

                for (const bid of bids) {
                    accumulated += parseFloat(bid.size || 0);
                    worstPrice = parseFloat(bid.price);
                    if (accumulated >= sharesToSell) break;
                }

                const slippagePercent = ((bestBidPrice - worstPrice) / bestBidPrice) * 100;

                // Protección fuerte contra slippage
                if (slippagePercent > 18) {
                    console.log(`⚠️ Slippage muy alto (${slippagePercent.toFixed(1)}%). Abortando venta.`);
                    continue;
                }

                console.log(`📊 Radar Sell → Mejor precio: $${bestBidPrice} | Slippage: ${slippagePercent.toFixed(1)}%`);

                // Limpiar órdenes previas
                try { await clobClient.cancelAll(); } catch (e) {}

                // Ejecutar venta
                await clobClient.createAndPostOrder({
                    tokenID: pos.tokenId,
                    price: worstPrice,        // Precio seguro del libro
                    side: Side.SELL,
                    size: sharesToSell
                });

                // Marcar como cerrado hoy
                closedPositionsCache.add(pos.tokenId);

                // Alerta Telegram
                const rescateEstimado = (sharesToSell * bestBidPrice).toFixed(2);
                await sendAlert(
                    `🛑 *VENTA AUTOMÁTICA (STOP LOSS)*\n` +
                    `Mercado: ${pos.marketName}\n` +
                    `PnL: ${profit.toFixed(1)}%\n` +
                    `Rescatado ≈ $${rescateEstimado} USDC`
                );

                await updateRealBalances();

            } catch (e) {
                console.error(`❌ Error vendiendo ${marketNameShort}:`, e.message);
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
        // Guardamos el balance inicial del día si es el primer chequeo
        if (botStatus.dailyStartBalance === 0) {
            botStatus.dailyStartBalance = parseFloat(botStatus.clobOnlyUSDC || 0);
        }

        const currentBalance = parseFloat(botStatus.clobOnlyUSDC || 0);
        const dailyPnL = currentBalance - botStatus.dailyStartBalance;
        botStatus.dailyPnL = dailyPnL;

        const lossPercent = botStatus.dailyStartBalance > 0 
            ? (dailyPnL / botStatus.dailyStartBalance) * 100 
            : 0;

        console.log(`📉 [DAILY LIMIT] PnL del día: $${dailyPnL.toFixed(2)} (${lossPercent.toFixed(1)}%)`);

        // Si se supera el límite de pérdida → Panic Stop
        if (lossPercent <= -botStatus.dailyLossLimit) {
            console.log(`🚨 [DAILY LIMIT] Stop-loss diario activado (${lossPercent.toFixed(1)}%). Deteniendo bot...`);
            botStatus.isPanicStopped = true;
            await sendAlert(`🚨 *STOP-LOSS DIARIO ACTIVADO*\nPérdida del día: ${lossPercent.toFixed(1)}%\nBot detenido automáticamente.`);
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
    res.json(botStatus);
});

app.post('/api/settings/threshold', async (req, res) => {
    const newThreshold = parseFloat(req.body.threshold);
    if (!isNaN(newThreshold)) {
        botStatus.predictionThreshold = newThreshold;
        console.log(`⚙️ Nuevo umbral configurado: ${newThreshold}`);
        res.json({ success: true, current: botStatus.predictionThreshold });
    } else {
        res.status(400).json({ error: "Valor inválido" });
    }
});

// 2. Recibe la orden del Switch "AutoTrade" desde la interfaz Vue
app.post('/api/settings/autotrade', (req, res) => {
    const { enabled, amount, edgeThreshold, takeProfitThreshold } = req.body; 
    
    if (enabled !== undefined) botStatus.autoTradeEnabled = !!enabled;
    if (amount !== undefined) botStatus.microBetAmount = parseFloat(amount) || botStatus.microBetAmount;
    if (edgeThreshold !== undefined) botStatus.edgeThreshold = parseFloat(edgeThreshold); 
    // 👇 NUEVO: Guardamos el Take Profit
    if (takeProfitThreshold !== undefined) botStatus.takeProfitThreshold = parseFloat(takeProfitThreshold); 
    
    console.log(`\n⚙️ [CONTROL] Autopilot: ${botStatus.autoTradeEnabled} | Calibre: $${botStatus.microBetAmount} | Min Edge: ${(botStatus.edgeThreshold * 100).toFixed(0)}% | Take Profit: ${botStatus.takeProfitThreshold}%`);
    
    res.json({ 
        success: true, 
        autoTradeEnabled: botStatus.autoTradeEnabled, 
        microBetAmount: botStatus.microBetAmount,
        edgeThreshold: botStatus.edgeThreshold,
        takeProfitThreshold: botStatus.takeProfitThreshold
    });
});

// Toggle Copy-Trading + filtros
app.post('/api/settings/copytrading', (req, res) => {
    const { enabled, maxCopySize, maxCopyPercent, maxWhalesToCopy } = req.body;
    
    if (enabled !== undefined) botStatus.copyTradingEnabled = !!enabled;
    if (maxCopySize !== undefined) botStatus.maxCopySize = parseFloat(maxCopySize) || 50;
    if (maxCopyPercent !== undefined) botStatus.maxCopyPercentOfBalance = parseFloat(maxCopyPercent) || 8;
    // 👇 NUEVO: Guardamos la cantidad de ballenas a seguir
    if (maxWhalesToCopy !== undefined) {
        botStatus.maxWhalesToCopy = parseInt(maxWhalesToCopy) || 10;
        // Reiniciamos el temporizador para que busque ballenas nuevas de inmediato
        botStatus.lastWhaleSelection = null; 
    }

    console.log(`⚙️ Copy-Trading: ${botStatus.copyTradingEnabled ? 'ON' : 'OFF'} | Max Size: ${botStatus.maxCopySize} shares | Max % Balance: ${botStatus.maxCopyPercentOfBalance}% | Ballenas: ${botStatus.maxWhalesToCopy}`);
    
    res.json({ 
        success: true, 
        copyTradingEnabled: botStatus.copyTradingEnabled,
        maxCopySize: botStatus.maxCopySize,
        maxCopyPercentOfBalance: botStatus.maxCopyPercentOfBalance,
        maxWhalesToCopy: botStatus.maxWhalesToCopy
    });
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

// Toggle Copy-Trading + filtros
app.post('/api/settings/copytrading', (req, res) => {
    const { enabled, maxCopySize, maxCopyPercent } = req.body;
    
    if (enabled !== undefined) botStatus.copyTradingEnabled = !!enabled;
    if (maxCopySize !== undefined) botStatus.maxCopySize = parseFloat(maxCopySize) || 50;
    if (maxCopyPercent !== undefined) botStatus.maxCopyPercentOfBalance = parseFloat(maxCopyPercent) || 8;

    console.log(`⚙️ Copy-Trading: ${botStatus.copyTradingEnabled ? 'ON' : 'OFF'} | Max Size: ${botStatus.maxCopySize} shares | Max % Balance: ${botStatus.maxCopyPercentOfBalance}%`);
    
    res.json({ 
        success: true, 
        copyTradingEnabled: botStatus.copyTradingEnabled,
        maxCopySize: botStatus.maxCopySize,
        maxCopyPercentOfBalance: botStatus.maxCopyPercentOfBalance
    });
});

// ==========================================
// 11. INICIO DEL MOTOR DEL SNIPER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🎯 POLY-SNIPER V2: SERVIDOR ACTIVO EN PUERTO ${PORT}`);
    console.log(`======================================================\n`);
    
    // 🟢 UN SOLO RELOJ MAESTRO
    setInterval(runBot, 60000);            // Escanear y disparar cada 1 minuto
    setInterval(monitorPortfolio, 180000); // Vigilar ganancias cada 3 minutos
    
    // Arranque inicial controlado
    updateRealBalances().then(() => {
        runBot();
    });
});