// 1. 🛠️ FIX CRÍTICO: Inyectar Web Crypto API (Esto evita el error 'subtle' en Docker)
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}
import { ClobClient, Chain, OrderType, Side } from '@polymarket/clob-client';
import Anthropic from '@anthropic-ai/sdk';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import Parser from 'rss-parser';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import https from 'https';
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// --- CONFIGURACIÓN DE MODELOS IA ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Gemini se usará para traducciones y tareas ligeras (más barato/gratis)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- CONFIGURACIÓN DE LA API PARA EL DASHBOARD ---
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

// Estado en memoria Evolucionado: Escáner de Oportunidades
let botStatus = {
    lastCheck: null,
    lastProbability: 0,
    currentMarket: { title: "Iniciando escáner...", title_es: "Iniciando escáner..." }, 
    currentTopic: "Inicializando radares...",
    watchlist: [],
    lastNews: [], 
    balanceUSDC: "0.00",
    balancePOL: "0.00",
    executions: [], 
    pendingSignals: [], 
    isPanicStopped: false,
    predictionThreshold: 0.70,
    // --- NUEVOS CAMPOS DE AUTO-TRADE ---
    autoTradeEnabled: false,
    microBetAmount: 1.00,
    // --- NUEVOS CAMPOS DE COSTO ---
    suggestedInversion: 0, 
    potentialROI: 0
};

// --- INICIALIZACIONES ---
const telegram = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;
const parser = new Parser();

// --- CONFIGURACIÓN REAL ACTIVADA ---
// const provider = new ethers.providers.JsonRpcProvider("https://rpc.ankr.com/polygon");
// Cambia tu línea de provider por esta de Cloudflare (es muy estable)
const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY, provider);

const UNISWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 Router
const WPOL_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WPOL (Wrapped POL)
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

// CONFIGURACIÓN DE POLYMARKET (POLYGON)
const CTF_EXCHANGE_ADDRESS = "0x4BFb304598296E5105583dA39cE9dcFD29944545"; // Dirección del Exchange ABI USDC Nativo
const CONDITIONAL_TOKENS = "0x4D970a13A32C37F5d63738cf738194482B3256A8"; // Contrato de tokens condicionales

// ABI Mínimo para aprobar USDC y comprar
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];
const EXCHANGE_ABI = [
    "function placeOrder(tuple(address maker, address taker, uint256 makerAmount, uint256 takerAmount, uint256 makerTokenId, uint256 takerTokenId, uint256 salt, uint256 expiry, uint256 nonce, uint8 signatureType, bytes signature) order) external"
];

console.log("✅ MODO REAL ACTIVADO");
console.log("Wallet vinculada:", wallet.address);

const PROXY_ADDRESS = process.env.POLY_PROXY_ADDRESS

// 1. Inicialización limpia (Línea 75 aprox)
// 1. Inicialización Global (Al principio de tu script)
let clobClient;

async function conectarClob() {
    try {
        console.log("🔐 Autenticando Wallet Personal (EOA)...");
        
        // Cliente temporal para obtener las llaves
        const authClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
        
        // Generamos credenciales frescas usando tu firma digital
        const apiCreds = await authClient.createOrDeriveApiKey(); 

        // Cliente REAL para trading
        clobClient = new ClobClient(
            "https://clob.polymarket.com", 
            137, 
            wallet, 
            apiCreds, 
            0 // <--- SIGTYPE 0 porque el dinero está en TU wallet
        );

        // Parche de Contrato (Crucial para que Polymarket acepte la firma)
        clobClient.getContractConfig = () => ({
            name: "ClobExchange",
            version: "1",
            chainId: 137,
            verifyingContract: "0x4BFb304598296E5105583dA39cE9dcFD29944545"
        });

        console.log("✅ CLOB Conectado: Listo para usar tus USDC personales.");
    } catch (e) {
        console.error("❌ Error de Conexión CLOB:", e.message);
    }
}

// Llamamos a la conexión al arrancar el server
conectarClob();



// --- FUNCIÓN DE TRADUCCIÓN (COMENTADA PARA AHORRO) ---
async function traducirConIA(texto) {
    if (!texto) return "";
    /*
    try {
        const prompt = `Translate this crypto/tech news headline to Spanish. Return ONLY the translated text: "${texto}"`;
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (e) {
        console.log("❌ ERROR TRADUCCIÓN GEMINI:", e.message);
        // Fallback simple si falla Gemini
        return texto; 
    }
    */
    return texto;
}

// --- FUNCIONES CORE ---

async function updateRealBalances() {
    try {
        const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const abi = ["function balanceOf(address) view returns (uint256)"];
        const contract = new ethers.Contract(USDC_NATIVE, abi, provider);
        
        const bal = await contract.balanceOf(wallet.address);
        botStatus.balanceUSDC = ethers.utils.formatUnits(bal, 6);
        
        console.log(`💰 Balance Real en Wallet: $${botStatus.balanceUSDC} USDC`);
    } catch (e) { console.error(e.message); }
}

async function analyzeMarketWithClaude(marketQuestion, currentNews) {
  console.log("--- Consultando a Claude Sonnet 4.6 (Análisis de Mercado) ---");
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6", 
      max_tokens: 150,
      system: `Eres un experto en mercados de predicción. 
      Responde estrictamente en JSON: 
      { 
        "prob": 0.XX, 
        "reason": "frase corta", 
        "searchQuery": "3-4 palabras clave para buscar el contrato en Polymarket" 
      }`,
      messages: [
        {
          role: "user",
          content: `Noticia: ${marketQuestion}. \nContexto: ${currentNews}. \nAnaliza la probabilidad de este mercado.`
        }
      ]
    });

    let rawText = response.content[0].text;
    const jsonMatch = rawText.match(/\{.*\}/s); 
    
    if (!jsonMatch) return { prob: 0, reason: "Error formato", searchQuery: marketQuestion };

    const data = JSON.parse(jsonMatch[0]);
    return {
        prob: parseFloat(data.prob) || 0,
        reason: data.reason || "Sin descripción.",
        searchQuery: data.searchQuery || marketQuestion
    };

  } catch (error) {
    console.error("❌ Error en analyzeMarketWithClaude:", error.message);
    return { prob: 0, reason: "Error de conexión", searchQuery: marketQuestion };
  }
}

async function getLatestNews(query, category) {
    try {
        let searchQuery = query;
        if (category === 'CRYPTO') searchQuery += ' "CPI" OR "Fed" OR "crypto" OR "Bitcoin" OR "SEC"';
        else if (category === 'GEOPOLITICS') searchQuery += ' "military" OR "attack" OR "official" OR "news"';
        else if (category === 'SOCIAL') searchQuery += ' "twitter" OR "tweet" OR "mentions" OR "post"';

        const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`);
        const rawItems = feed.items.slice(0, 5);
        
        const newsList = [];
        for (const item of rawItems) {
            // Ya no traducimos aquí para ahorrar créditos
            newsList.push({
                title: item.title,      
                title_es: "Traducción pausada (ahorro)",     
                link: item.link         
            });
        }
        
        botStatus.lastNews = newsList;
        return newsList.map(n => n.title).join(". "); 
        
    } catch (error) { 
        botStatus.lastNews = [{ title: "No news found", title_es: "No se encontraron noticias." }];
        return "No hay noticias."; 
    }
}

async function sendAlert(message) {
    try { await telegram.sendMessage(chatId, `🤖 *PolyBot Alert*:\n${message}`, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function sendSniperAlert(signal) {
    const closingStr = signal.endsIn ? `⏰ Cierra en: *${signal.endsIn}*` : '';
    const edgePct = signal.edge >= 0 ? `+${(signal.edge * 100).toFixed(0)}%` : `${(signal.edge * 100).toFixed(0)}%`;
    const msg =
        `🎯 *SNIPER ALERT* — Mercado Próximo a Cerrar\n` +
        `${closingStr}\n\n` +
        `📋 ${signal.marketName_es || signal.marketName}\n\n` +
        `🧠 Claude IA: *${(signal.probability * 100).toFixed(0)}%*\n` +
        `📊 Precio Mercado: *$${signal.marketPrice}*\n` +
        `📈 Edge de Ventaja: *${edgePct} subvalorado*\n\n` +
        `💰 Inversión sugerida: *${signal.suggestedInversion} USDC*\n` +
        `📝 Razón: ${signal.reasoning}`;
    try { await telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch (e) {
        console.error('❌ Error enviando Sniper Alert a Telegram:', e.message);
    }
}

async function findPolymarketId(title) {
    try {
        const agent = new https.Agent({ rejectUnauthorized: false });
        
        // 1. Limpiamos el título de "basura" de noticias (nombres de sitios, preguntas retóricas)
        let cleanTitle = title.split(' - ')[0]
            .replace(/Why Is|How Low Can|Prediction 2026|Trading Odds/gi, '')
            .replace(/[^\w\s]/gi, '')
            .trim();

        // 2. Extraemos solo las primeras 3 palabras clave (ej: "Bitcoin Price March")
        const keywords = cleanTitle.split(' ').filter(w => w.length > 2).slice(0, 3).join(' ');
        
        console.log(`📡 Buscando mercado real para: "${keywords}"`);

        const url = `https://gamma-api.polymarket.com/markets?active=true&limit=5&search=${encodeURIComponent(keywords)}`;

        const response = await axios.get(url, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (response.data && response.data.length > 0) {
            // Buscamos el mercado más relevante que esté abierto
            const market = response.data.find(m => m.conditionId && !m.closed && m.active);
            
            if (market) {
                console.log(`✅ ¡MERCADO VINCULADO!: ${market.question}`);
                return { conditionId: market.conditionId, question: market.question };
            }
        }
        
        return null;
    } catch (error) {
        console.error("❌ Error en búsqueda Polymarket:", error.message);
        return null;
    }
}

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

// --- VARIABLES GLOBALES DE CONTROL ---
let watchlistIndex = 0;

// Helper: cuántas horas faltan para cierre del mercado
function hoursUntilClose(endDateStr) {
    if (!endDateStr) return 999;
    const diff = new Date(endDateStr) - Date.now();
    return diff / (1000 * 60 * 60);
}

async function getMarketDetails(conditionId) {
    try {
        const agent = new https.Agent({ rejectUnauthorized: false });
        const response = await axios.get(
            `https://gamma-api.polymarket.com/markets?conditionId=${conditionId}`,
            { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const m = response.data && response.data[0];
        if (!m) return null;

        let yesPrice = null;
        if (m.outcomePrices) {
            try {
                const prices = JSON.parse(m.outcomePrices);
                yesPrice = prices.length > 0 ? parseFloat(prices[0]) : null;
            } catch (e) {
                console.error("Error parsing outcomePrices:", e.message);
            }
        }

        return {
            price: yesPrice !== null && !isNaN(yesPrice) ? yesPrice : null,
            endDate: m.endDate,
            endsInHours: hoursUntilClose(m.endDate),
            volume: parseFloat(m.volume || 0)
        };
    } catch (e) {
        console.error('❌ Error en getMarketDetails:', e.message);
        return null;
    }
}

// Keywords for categorization
// Keywords for categorization
const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto', 'etf', 'halving', 'xrp'];
const geopoliticsKeywords = ['israel', 'ukraine', 'russia', 'gaza', 'iran', 'lebanon', 'putin', 'biden', 'offensive', 'ceasefire', 'war', 'strikes'];
const socialKeywords = ['elon', 'musk', 'trump', 'tweet', 'tweets', 'mention', 'mentions', 'post', 'posts', 'x'];

function getMarketCategory(title) {
    const matchAny = (words) => words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(title));
    
    if (matchAny(cryptoKeywords)) return 'CRYPTO';
    if (matchAny(geopoliticsKeywords)) return 'GEOPOLITICS';
    if (matchAny(socialKeywords)) return 'SOCIAL';
    return null; // Ignore general markets
}

async function refreshWatchlist() {
    try {
        botStatus.currentTopic = 'Escaneando Pilares de Alta Liquidez...';
        console.log(`\n⏰ [SNIPER] Buscando mercados de Cripto, Geopolítica y Redes Sociales...`);

        const agent = new https.Agent({ rejectUnauthorized: false });

        // Pedimos 500 mercados activos para escaneo profundo (Deep Scan)
        const polyRes = await axios.get(
            'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500',
            { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );

        if (!polyRes.data || polyRes.data.length === 0)
            throw new Error('No se obtuvieron mercados de Polymarket');

        const now = Date.now();

        // 1. Filter future markets
        const futureMarkets = polyRes.data.filter(m => {
            if (!m.conditionId || !m.endDate) return false;
            return new Date(m.endDate).getTime() > now;
        });

        // 2. Categorize and keep only our 3 Pillars
        const targetedMarkets = futureMarkets.map(m => {
            return { ...m, category: getMarketCategory(m.question) };
        }).filter(m => m.category !== null);

        // 3. Sort prioritize <48h markets, then by volume
        targetedMarkets.sort((a, b) => {
            const hrsA = hoursUntilClose(a.endDate);
            const hrsB = hoursUntilClose(b.endDate);
            const isSoonA = hrsA <= 48 ? 1 : 0;
            const isSoonB = hrsB <= 48 ? 1 : 0;
            
            if (isSoonA !== isSoonB) return isSoonB - isSoonA; // Prioritize soon
            return parseFloat(b.volume || 0) - parseFloat(a.volume || 0); // Then by volume
        });

        // Let's guarantee a mix of categories if possible (e.g. 2 crypto, 1 geo, 1 social)
        const finalPool = [];
        const cats = ['CRYPTO', 'GEOPOLITICS', 'SOCIAL'];
        let idx = 0;
        
        while (finalPool.length < 4 && targetedMarkets.length > 0) {
            const desiredCat = cats[idx % cats.length];
            const matchIdx = targetedMarkets.findIndex(m => m.category === desiredCat);
            if (matchIdx !== -1) {
                finalPool.push(targetedMarkets[matchIdx]);
                targetedMarkets.splice(matchIdx, 1);
            } else if (targetedMarkets.length > 0) {
                // if preferred category not found, take the highest vol available
                finalPool.push(targetedMarkets[0]);
                targetedMarkets.splice(0, 1);
            }
            idx++;
        }

        console.log(`⏰ [SNIPER] Pool seleccionado: ${finalPool.length} mercados clave (Cripto/Geo/Social)`);

        const rawTrends = [];
        for (const market of finalPool) {
            // YA NO TRADUCIMOS AQUÍ. Solo lo haremos cuando se seleccione para análisis profundo.
            const title_es = "Pendiente de análisis...";
            const hrs = hoursUntilClose(market.endDate);
            const hrsLabel = hrs < 1 ? `${Math.round(hrs * 60)}min`
                           : hrs < 24 ? `${hrs.toFixed(1)}h`
                           : `${Math.ceil(hrs / 24)}d`;
            
            let currentPrice = null;
            if (market.outcomePrices) {
                try {
                    const prices = JSON.parse(market.outcomePrices);
                    currentPrice = prices.length > 0 ? parseFloat(prices[0]) : null;
                } catch(e){}
            }

            let clobTokenId = null;
            if (market.clobTokenIds) {
                try {
                    // Gamma API returns a stringified array like '["754...", "384..."]'
                    const tokens = JSON.parse(market.clobTokenIds);
                    clobTokenId = tokens.length > 0 ? tokens[0] : null;
                } catch(e){}
            }

            rawTrends.push({
                title: market.question,
                title_es: title_es,
                category: market.category,
                conditionId: market.conditionId,
                tokenId: clobTokenId,
                isTradeable: true,
                endDate: market.endDate,
                endsIn: hrsLabel,
                marketPrice: currentPrice
            });
            console.log(`🎯 [SNIPER] Slot (${market.category}): "${market.question.substring(0, 45)}..." | Cierra en ${hrsLabel} | MKT: $${currentPrice || 0}`);
        }

        botStatus.watchlist = rawTrends;

    } catch (e) {
        console.error('❌ Error en refreshWatchlist:', e.message);
        botStatus.watchlist = [{ title: 'Error', title_es: 'Error al cargar mercados', conditionId: null }];
    }
}

async function executeSwapLogic(amountInPol) {
    try {
        // Direcciones oficiales Polygon POS
        const ROUTER_V3 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
        const WPOL = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
        const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

        const amountInWei = ethers.utils.parseEther(amountInPol.toString());
        
        const router = new ethers.Contract(
            ROUTER_V3,
            ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX9)) external payable returns (uint256 amountOut)'],
            wallet
        );

        console.log(`\n--- 🚀 INICIANDO TRANSACCIÓN REAL ---`);
        console.log(`Monto: ${amountInPol} POL`);

        const params = {
            tokenIn: WPOL,
            tokenOut: USDC,
            fee: 3000, // 0.3% pool
            recipient: wallet.address,
            amountIn: amountInWei,
            amountOutMinimum: 0, // En producción usa un cálculo de slippage
            sqrtPriceLimitX9: 0
        };

        // Ejecutamos el swap enviando el POL como 'value'
        const tx = await router.exactInputSingle(params, {
            value: amountInWei,
            gasLimit: 350000,
            gasPrice: await provider.getGasPrice() // Forzamos el precio de mercado actual
        });

        console.log(`📡 Transacción enviada a la red. Hash: ${tx.hash}`);
        
        const receipt = await tx.wait();
        console.log(`✅ CONFIRMADO: Swap exitoso en bloque ${receipt.blockNumber}`);
        
        return true;
    } catch (error) {
        console.error("❌ ERROR CRÍTICO EN SWAP:");
        if (error.reason) console.error(`Razón: ${error.reason}`);
        console.error(error);
        throw error;
    }
}

// --- MODIFICA TU FUNCIÓN DE EJECUCIÓN ---
// Asegúrate de tener estas constantes definidas arriba en tu index.js
const CTF_EXCHANGE = "0x4BFb304598296E5105583dA39cE9dcFD29944545"; 

async function executeTradeOnChain(conditionId, tokenId, amountUsdc, currentPrice) {
    try {
        console.log(`\n--- ⚖️ EJECUCIÓN ON-CHAIN EN POLYMARKET ---`);
        
        if (!clobClient) throw new Error("El cliente CLOB no está inicializado.");

        // --- BLOQUE DE PERMISOS (EL QUE FALTA) ---
        const amountWei = ethers.utils.parseUnits(amountUsdc.toString(), 6);
        const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        
        console.log("🔍 Verificando permisos (Allowance)...");
        const currentAllowance = await usdcContract.allowance(wallet.address, CTF_EXCHANGE);

        if (currentAllowance.lt(amountWei)) {
            console.log("🔓 Allowance insuficiente. Enviando transacción de APPROVE...");
            // Esto solo se hace una vez en la vida de la wallet
            const tx = await usdcContract.approve(CTF_EXCHANGE, ethers.constants.MaxUint256);
            console.log(`📡 Transacción enviada: ${tx.hash}. Esperando confirmación...`);
            await tx.wait();
            console.log("✅ Permiso (Allowance) concedido exitosamente.");
        }
        // ------------------------------------------

        const numShares = Math.floor((parseFloat(amountUsdc) / parseFloat(currentPrice)) * 10) / 10;
        const finalPrice = Number(parseFloat(currentPrice).toFixed(4)); 

        console.log(`📡 Postulando orden Limit BUY vía CLOB GLOBAL...`);
        
        const order = await clobClient.createOrder({
            tokenID: tokenId,
            price: finalPrice,
            side: Side.BUY,
            size: numShares,
            collateralAddress: USDC_ADDRESS
        });

        const response = await clobClient.postOrder(order);

        if (response && response.success) {
            console.log(`🎉 ¡ORDEN ACEPTADA! ID: ${response.orderID}`);
            return { success: true, hash: response.orderID };
        } else {
            throw new Error(`Rechazo del nodo CLOB: ${JSON.stringify(response)}`);
        }
    } catch (error) {
        console.error("❌ Error en executeTradeOnChain:", error.message);
        throw error;
    }
}

async function runBot() {
    if (botStatus.isPanicStopped) {
        console.log("🛑 BOT DETENIDO MANUALMENTE. Ignorando ciclo.");
        return;
    }

    console.log(`\n--- INICIANDO CICLO DE ESCANEO: ${new Date().toLocaleString()} ---`);
    botStatus.lastCheck = new Date().toLocaleString();

    try {
        if (botStatus.watchlist.length === 0 || watchlistIndex >= botStatus.watchlist.length) {
            await refreshWatchlist();
            watchlistIndex = 0;
        }

        // Guard: if still empty after refresh, skip this cycle
        if (botStatus.watchlist.length === 0) {
            console.log('⚠️ Watchlist vacwíúoa tras refresh, reintentando en el próximo ciclo...');
            return;
        }

        // 3. ELEGIR MERCADO ACTUAL
        const marketItem = botStatus.watchlist[watchlistIndex];
        const marketTitle = typeof marketItem === 'object' ? marketItem.title : marketItem;
        // Solo traducimos el título ACTUAL si es necesario (cuando prob sea alta se sobreescribirá)
        let marketTitleEs = typeof marketItem === 'object' && marketItem.title_es !== "Pendiente de análisis..." 
            ? marketItem.title_es : "Analizando...";
        
        const endsIn = marketItem.endsIn || null;
        const endDate = marketItem.endDate || null;

        botStatus.currentMarket = { title: marketTitle, title_es: marketTitleEs, category: marketItem.category };
        botStatus.currentTopic = marketTitle;

        const catLabel = marketItem.category ? ` [${marketItem.category}]` : '';
        const endsLabel = endsIn ? ` | ⏰ Cierra en ${endsIn}` : '';
        console.log(`🔍 ANALIZANDO [${watchlistIndex + 1}/${botStatus.watchlist.length}]: ${marketTitle}${catLabel}${endsLabel}`);

        await updateRealBalances();

        const realNews = await getLatestNews(marketTitle, marketItem.category);
        const analysis = await analyzeMarketWithClaude(marketTitle, realNews);
        botStatus.lastProbability = analysis.prob;
        const prob = analysis.prob;

        // INJECT PROBABILITY TO UI WATCHLIST IN REAL-TIME
        if (botStatus.watchlist[watchlistIndex]) {
            botStatus.watchlist[watchlistIndex].probability = prob;
        }

        console.log(`📊 Probabilidad (Claude): ${(prob * 100).toFixed(0)}% | Razón: ${analysis.reason}`);

        // --- LÓGICA SNIPER: obtener precio real del mercado y calcular edge ---
        const livePrice = marketItem.marketPrice !== undefined ? marketItem.marketPrice : null;
        let originalEndsInHours = 999;
        if (endDate) originalEndsInHours = hoursUntilClose(endDate);
        
        let endsInHours = originalEndsInHours;
        
        // Optional fallback check using getMarketDetails if price is missing
        if (livePrice === null && marketItem.conditionId) {
             const liveDetails = await getMarketDetails(marketItem.conditionId);
             if (liveDetails && liveDetails.price !== null) {
                 marketItem.marketPrice = liveDetails.price;
                 if (liveDetails.endsInHours) endsInHours = liveDetails.endsInHours;
             }
        }
        
        const finalLivePrice = marketItem.marketPrice !== undefined ? marketItem.marketPrice : null;
        const edge = finalLivePrice !== null ? prob - finalLivePrice : null;

        if (finalLivePrice !== null) {
            const sniperQualified = edge >= 0.10 && endsInHours <= 24 && prob >= botStatus.predictionThreshold;
            console.log(`⏰ Cierra en: ${endsInHours.toFixed(1)}h | Precio mercado: $${finalLivePrice.toFixed(2)} | Edge: ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(0)}%${sniperQualified ? ' 🎯 SNIPER!' : ''}`);
        }

        if (prob >= botStatus.predictionThreshold) {
            console.log(`🔥 OPORTUNIDAD DETECTADA: ${(prob * 100).toFixed(0)}%`);

            // EL SNIPER TRADUCE SOLO SI LA PROB ES ALTA (AHORRO CON GEMINI)
            const marketTitleEs = await traducirConIA(marketTitle);
            const razonES = await traducirConIA(analysis.reason);

            // Actualizamos los títulos para el Dashboard
            botStatus.currentMarket.title_es = marketTitleEs;
            if (botStatus.watchlist[watchlistIndex]) {
                botStatus.watchlist[watchlistIndex].title_es = marketTitleEs;
            }

            const signalIndex = botStatus.pendingSignals.findIndex(s => s.marketName === marketTitle);

            if (signalIndex === -1) {
                console.log(`🔍 Validando ID para: ${marketTitle.substring(0, 30)}...`);

                const conditionId = marketItem.conditionId;

                const balanceActual = parseFloat(botStatus.balanceUSDC || 0);
                const suggestedInversion = balanceActual > 0 ? (balanceActual * 0.05) : 10.00;
                const potentialROI = prob > 0 ? (suggestedInversion * (1 / prob) - suggestedInversion) : 0;
                
                // Fallback secondary price fetch if absolutely everything logic failed
                let marketPrice = finalLivePrice !== null ? finalLivePrice : await getMarketPrice(marketItem.tokenId);
                marketPrice = marketPrice ? Number(marketPrice) : 0;
                // --- AUTO-TRADE ---
                let autoExecuted = false;
                if (botStatus.autoTradeEnabled && conditionId && marketPrice && Number(marketPrice) < prob) {
                    console.log(`⚡ AUTO-TRADE INICIADO: Comprando ${botStatus.microBetAmount} USDC en ${marketTitle}`);
                    try {
                        const amountToBet = botStatus.microBetAmount;
                        const result = await executeTradeOnChain(conditionId, marketItem.tokenId, amountToBet, marketPrice);
                        if (result && result.success) {
                            const execution = {
                                id: result.hash.substring(0, 12),
                                conditionId: conditionId,
                                market: marketTitle,
                                price: parseFloat(marketPrice),
                                investment: parseFloat(amountToBet),
                                shares: (parseFloat(amountToBet) / parseFloat(marketPrice)).toFixed(2),
                                date: new Date().toLocaleString(),
                                status: 'COMPLETED (AUTO)'
                            };
                            botStatus.executions.unshift(execution);
                            await sendAlert(`🚀 *NUEVA TRANSACCIÓN EJECUTADA (AUTOPILOT)*\nMercado: ${marketTitleEs}\nPrecio de entrada: $${marketPrice}\nInversión apostada: $${amountToBet} USDC\nID Blockchain: ${execution.id}`);
                            autoExecuted = true;
                        }
                    } catch (e) {
                        console.error('❌ Auto-Trade Falló:', e.message);
                        await sendAlert(`❌ *FALLA DE TRANSACCIÓN (AUTOPILOT)*\nMercado: ${marketTitleEs}\nRazón: ${e.message}`);
                    }
                }

                if (!autoExecuted) {
                    const signalObj = {
                        id: Date.now(),
                        marketName: marketTitle,
                        marketName_es: marketTitleEs,
                        category: marketItem.category,
                        conditionId: conditionId,
                        tokenId: marketItem.tokenId,
                        isTradeable: !!conditionId && !!marketItem.tokenId,
                        probability: prob,
                        reasoning: razonES,
                        suggestedInversion: Number(suggestedInversion.toFixed(2)),
                        potentialROI: Number(potentialROI.toFixed(2)),
                        marketPrice: marketPrice || 0,
                        endsIn: endsIn,
                        edge: edge
                    };
                    botStatus.pendingSignals.unshift(signalObj);

                    console.log(`💎 SEÑAL INYECTADA: ${marketTitle.substring(0, 20)}`);
                    if (botStatus.pendingSignals.length > 5) botStatus.pendingSignals.pop();

                    // --- Telegram: sniper vs normal ---
                    if (edge !== null && edge >= 0.10 && endsInHours <= 24) {
                        await sendSniperAlert(signalObj);
                    } else {
                        const statusEmoji = conditionId ? '✅ ON-CHAIN' : 'ℹ️ SOLO INFO';
                        await sendAlert(
                            `🟢 *NUEVA SEÑAL* [${statusEmoji}]\n` +
                            `Mercado: ${marketTitleEs}\n` +
                            `Probabilidad: ${(prob * 100).toFixed(0)}%\n` +
                            `Inversión: ${suggestedInversion.toFixed(2)} USDC`
                        );
                    }
                }
            } else {
                console.log('ℹ️ La señal ya está en el Dashboard, saltando push.');
            }
        }

        watchlistIndex++;

    } catch (error) {
        console.error('❌ Error crítico en runBot:', error.stack);
    }
}

// --- RUTAS DE LA API PARA EL FRONTEND ---

app.get('/api/status', (req, res) => {
    res.json({
        ...botStatus,
        pendingSignals: botStatus.pendingSignals 
    });
});

app.post('/api/change-market', (req, res) => {
    if (botStatus.isPanicStopped) return res.status(403).json({ success: false, message: "Bot detenido." });
    
    // Al cambiar manual, reseteamos a formato objeto
    botStatus.currentMarket = { title: req.body.newMarket, title_es: "Analizando cambio..." };
    botStatus.lastProbability = 0; 
    runBot(); 
    res.json({ success: true, message: `Cambiado a: ${req.body.newMarket}` });
});

app.post('/api/panic-stop', (req, res) => {
    botStatus.isPanicStopped = true;
    console.log("⚠️ ⚠️ ⚠️ EMERGENCY STOP ACTIVATED ⚠️ ⚠️ ⚠️");
    sendAlert("⚠️ *EMERGENCY STOP*: El bot ha sido detenido manualmente.");
    res.json({ success: true, message: "Bot detenido." });
});

app.post('/api/execute-trade', async (req, res) => {
    const { market, amount, conditionId, tokenId, probability } = req.body; 
    
    try {
        // 1. Obtenemos el precio real justo antes de comprar llamando al CLOB Midpoint
        let marketPrice = await getMarketPrice(tokenId);
        marketPrice = marketPrice ? Number(marketPrice) : 0;

        // 2. Ejecutamos la operación real en Polygon/CLOB
        const result = await executeTradeOnChain(conditionId, tokenId, amount, marketPrice);

        if (result.success) {
            const execution = { 
                id: result.hash.substring(0, 12), 
                conditionId: conditionId, // <--- INDISPENSABLE para el tracking
                market: market, 
                price: parseFloat(marketPrice), // Lo que costaba la acción (ej: 0.70)
                investment: parseFloat(amount), // Lo que gastaste (ej: 5.00)
                shares: (parseFloat(amount) / parseFloat(marketPrice)).toFixed(2), // Cuántas acciones compraste
                date: new Date().toLocaleString(),
                status: "COMPLETED"
            };

            // Usamos unshift para que la más reciente salga arriba
            botStatus.executions.unshift(execution);
            
            // Limpiamos la señal de la lista de pendientes
            botStatus.pendingSignals = botStatus.pendingSignals.filter(s => s.marketName !== market);
            
            await sendAlert(`💰 *OPERACIÓN REAL COMPLETADA*\nMercado: ${market}\nPrecio: $${marketPrice}\nInversión: $${amount} USDC`);
            
            res.json({ success: true, message: "Trade real ejecutado con éxito.", hash: result.hash });
        }
    } catch (e) {
        console.error("❌ Error en Trade:", e.message);
        res.status(500).json({ success: false, error: "La transacción falló en la blockchain." });
    }
});

// RUTA PARA EL SWAP CUSTOM
app.post('/api/swap-custom', async (req, res) => {
    const { amount } = req.body;
    
    // Respondemos rápido al front para que no se quede trabado
    res.json({ success: true, message: "Procesando swap..." });

    // Ejecutamos la lógica real
    try {
        const success = await executeSwapLogic(amount);
        if (success) {
            // Forzamos una actualización de balances en el backend justo después del swap
            await updateRealBalances(); 
            res.json({ success: true, message: "Swap completado y saldos actualizados" });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ESTO ES VITAL: Iniciar el servidor
app.listen(PORT, () => {
    console.log(`\n🚀 API del Bot activa en: http://localhost:${PORT}`);
    console.log(`📡 Esperando peticiones del Dashboard...`);
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

app.post('/api/settings/autotrade', (req, res) => {
    const { enabled, amount } = req.body;
    if (enabled !== undefined) botStatus.autoTradeEnabled = !!enabled;
    if (amount !== undefined) botStatus.microBetAmount = parseFloat(amount) || botStatus.microBetAmount;
    
    console.log(`🤖 Auto-Trade configurado: ${botStatus.autoTradeEnabled} | ${botStatus.microBetAmount} USDC`);
    res.json({ success: true, autoTradeEnabled: botStatus.autoTradeEnabled, microBetAmount: botStatus.microBetAmount });
});

app.get('/api/markets', (req, res) => {
    res.json(botStatus.watchlist);
});

// Arrancar servidor y ciclos
app.listen(PORT, () => {
    console.log(`📡 Terminal API activa en http://localhost:${PORT}`);
});

app.get('/test-balance', async (req, res) => {
    try {
        await updateRealBalances();
        res.json({
            success: true,
            wallet: wallet.address,
            usdc_en_billetera: botStatus.walletOnlyUSDC || "0.00",
            usdc_en_polymarket: botStatus.clobOnlyUSDC || "0.00",
            total_disponible: botStatus.balanceUSDC,
            pol_gas: botStatus.balancePOL,
            clob_conectado: !!clobClient
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Ruta para ver cómo van tus trades reales
app.get('/api/portfolio', async (req, res) => {
    try {
        const portfolio = botStatus.executions.map(async (exec) => {
            const currentPrice = await getMarketPrice(exec.conditionId);
            return {
                ...exec,
                currentPrice: currentPrice,
                profit: currentPrice ? (parseFloat(currentPrice) - exec.price).toFixed(2) : 0
            };
        });
        
        res.json(await Promise.all(portfolio));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// NUEVO: Monitor PnL para Telegram
async function monitorPortfolio() {
    if (botStatus.executions.length === 0) return;
    
    for (const pos of botStatus.executions) {
        if (pos.status && pos.status.includes("COMPLETED")) {
            const currentPrice = await getMarketPrice(pos.conditionId);
            if (currentPrice) {
                const profit = parseFloat(currentPrice) - pos.price;
                const roi = (profit / pos.price) * 100;
                
                // Criterio de cierre: Pierde o gana más del 5% del valor originario de la acción
                if (roi >= 5 || roi <= -5) {
                    pos.status = roi >= 5 ? "CLOSED (WIN ✨)" : "CLOSED (LOSS 📉)";
                    const netUSDC = (profit * pos.shares).toFixed(2);
                    
                    const msg = `🔔 *AUTO-TRADE CERRADO*\n` +
                                `${roi >= 5 ? '✅ GANANCIA' : '❌ PÉRDIDA'}: ${netUSDC} USDC\n` +
                                `Mercado: ${pos.market.substring(0,40)}...\n` +
                                `Entrada: $${pos.price.toFixed(2)} -> Salida: $${parseFloat(currentPrice).toFixed(2)}\n` +
                                `ROI: ${roi.toFixed(1)}%`;
                                
                    await sendAlert(msg);
                }
            }
        }
    }
}

app.post('/api/trade-ukraine', async (req, res) => {
    const UKRAINE_TOKEN_ID = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
    const { amount } = req.body; // El monto que pongas en el dashboard (ej: 3.00)

    try {
        console.log(`🚀 Iniciando Sniper en mercado de Ucrania: ${amount} USDC`);
        
        // Obtenemos el precio actual antes de comprar
        const currentPrice = await getMarketPrice(UKRAINE_TOKEN_ID) || 0.0045;

        const result = await executeTradeOnChain(
            "Russia x Ukraine ceasefire", 
            UKRAINE_TOKEN_ID, 
            amount, 
            currentPrice
        );

        res.json({ success: true, message: "Orden de Ucrania enviada!", hash: result.hash });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/test-clob-auth', async (req, res) => {
    try {
        console.log("🔐 Iniciando Protocolo de Firma para Wallet Personal...");
        
        // 1. Cliente temporal para FIRMAR y pedir llaves nuevas
        const authClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
        
        // 2. USAMOS EL NOMBRE CORRECTO DE 2026: createOrDeriveApiKey
        const derivedCreds = await authClient.createOrDeriveApiKey();
        
        console.log("✅ LLAVES GENERADAS CON ÉXITO");

        // 3. Probamos la conexión con Signature Type 0 (EOA)
        const finalClient = new ClobClient("https://clob.polymarket.com", 137, wallet, derivedCreds, 0);
        
        // 4. USAMOS UNA FUNCIÓN QUE NO FALLA: getSamplingMarkets
        // Esto confirma que el servidor CLOB acepta tus credenciales y te da datos
        const marketsSample = await finalClient.getSamplingMarkets();
        
        console.log("🚀 ¡CONEXIÓN TOTAL! El Sniper está autenticado en Polygon.");
        
        res.json({ 
            success: true, 
            message: "¡Conexión Exitosa con Wallet Personal!", 
            clob_status: "CONNECTED",
            address: wallet.address,
            markets_scanned: marketsSample.length
        });

    } catch (e) {
        console.error("❌ ERROR EN EL TEST DE AUTH:", e.message);
        res.status(500).json({ 
            success: false, 
            error: "Fallo de autenticación",
            details: e.message,
            tip: "Asegúrate de haber aceptado los términos de Polymarket en su web con esta wallet al menos una vez."
        });
    }
});

app.post('/api/execute-test-clob', async (req, res) => {
    try {
        console.log("🚀 Iniciando Protocolo Test-Clob (Ukraine Market)...");
        
        // Direcciones del script
        const TOKEN_ID = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
        const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const CTF_EXCHANGE = "0x4BFb304598296E5105583dA39cE9dcFD29944545";
        const NEG_RISK = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

        // 1. Verificar Allowances antes de comprar
        const usdc = new ethers.Contract(USDC_NATIVE, ERC20_ABI, wallet);
        const targets = [["CTF Exchange", CTF_EXCHANGE], ["NegRisk Adapter", NEG_RISK]];
        
        for (const [name, addr] of targets) {
            const allow = await usdc.allowance(wallet.address, addr);
            if (allow.lt(ethers.utils.parseUnits("1", 6))) {
                console.log(`🔓 Aprobando ${name}...`);
                const tx = await usdc.approve(addr, ethers.constants.MaxUint256);
                await tx.wait();
            }
        }

        // 2. Autenticación fresca
        const creds = await (new ClobClient("https://clob.polymarket.com", 137, wallet)).deriveApiKey();
        const testClient = new ClobClient("https://clob.polymarket.com", 137, wallet, creds, 0);
        
        testClient.getContractConfig = () => ({
            name: "ClobExchange",
            version: "1",
            chainId: 137,
            verifyingContract: CTF_EXCHANGE
        });

        // 3. Ejecutar Orden
        const order = await testClient.createOrder({
            tokenID: TOKEN_ID,
            price: 0.0045,
            side: Side.BUY,
            size: 3.00,
            feeRateBps: 0,
            collateralAddress: USDC_NATIVE,
        });

        const response = await testClient.postOrder(order);

        if (response && response.success) {
            res.json({ success: true, orderID: response.orderID });
        } else {
            throw new Error(response.errorMsg || JSON.stringify(response));
        }
    } catch (e) {
        console.error("💥 Error en Test-Clob:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/execute-test-sniper', async (req, res) => {
    try {
        console.log("🎯 INICIANDO PROTOCOLO TEST-TRADE (UCRANIA)");

        // 1. Instanciar Wallet con el Provider (usando tu lógica de getStableProvider)
        const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

        // 2. Derivar credenciales (Igual que en tu script)
        const tempClient = new ClobClient("https://clob.polymarket.com", 137, wallet);
        const creds = await tempClient.deriveApiKey();

        // 3. Crear Cliente con SigType 0 (EOA)
        const clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet, creds, 0);

        // 4. CONFIGURACIÓN DE CONTRATOS (El "Parche" vital)
        clobClient.getContractConfig = () => ({
            name: "ClobExchange",
            version: "1",
            chainId: 137,
            verifyingContract: "0x4BFb304598296E5105583dA39cE9dcFD29944545"
        });

        // 5. VERIFICACIÓN DE ALLOWANCES (Sección 3 de tu script)
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        const targets = [
            ["CTF Exchange", "0x4BFb304598296E5105583dA39cE9dcFD29944545"],
            ["NegRisk Adapter", "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"]
        ];

        for (const [name, addr] of targets) {
            const allow = await usdc.allowance(wallet.address, addr);
            if (allow.lt(ethers.utils.parseUnits("1", 6))) {
                console.log(`🔓 Aprobando ${name}...`);
                const tx = await usdc.approve(addr, ethers.constants.MaxUint256);
                await tx.wait();
            }
        }

        // 6. EJECUCIÓN DE LA ORDEN (Sección 5 de tu script)
        const order = await clobClient.createOrder({
            tokenID: "24394670903706558879845790079760859552309100903651562795058188175118941818512",
            price: 0.0045, // Precio del test
            side: Side.BUY,
            size: 3.00,    // Tamaño del test
            feeRateBps: 0,
            collateralAddress: USDC_ADDRESS
        });

        const response = await clobClient.postOrder(order);

        if (response && response.success) {
            console.log(`🎉 ORDEN ACEPTADA: ${response.orderID}`);
            res.json({ success: true, orderID: response.orderID });
        } else {
            throw new Error(JSON.stringify(response));
        }

    } catch (error) {
        console.error("💥 ERROR EN API TEST-TRADE:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

setInterval(runBot, 60000); // 1 minuto — Sniper Mode
setInterval(monitorPortfolio, 180000); // Revisar PnL cada 3 minutos

updateRealBalances(); 
runBot();