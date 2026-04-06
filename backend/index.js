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

const agent = new https.Agent({  
    rejectUnauthorized: false 
});

dotenv.config();

// --- CONFIGURACIÓN DE IA Y DASHBOARD ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;
// Memoria de corto plazo para ahorrar créditos
const analysisCache = new Map();

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
    autoTradeEnabled: false,
    microBetAmount: 1.00,
    suggestedInversion: 0, 
    potentialROI: 0
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

                // Variables extraídas de la API (soportando el JSON traducido o en inglés)
                const size = parseFloat(pos.size || pos['tamaño'] || 0);
                const cashPnl = parseFloat(pos.cashPnl || pos['ganancias en efectivo'] || 0);
                const percentPnl = parseFloat(pos.percentPnl || pos['porcentaje de ganancias'] || 0);
                const valorActual = parseFloat(pos.currentValue || pos.current_value || pos.value || pos['valor actual'] || 0);

                if (size > 0) {
                    const nombreMercado = pos.title || pos.market || pos['título'] || "Mercado Desconocido";
                    const tokenId = pos.asset || pos.token_id || pos.asset_id;
                    const conditionId = pos.conditionId || pos.condition_id;
                    const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                    botStatus.activePositions.push({
                        tokenId: tokenId,
                        conditionId: conditionId,
                        size: size.toFixed(2),
                        exactSize: size,
                        marketName: nombreMercado,
                        status: isRedeemable ? "FINALIZADO (CANJEAR) ♻️" : "ACTIVO 🟢",
                        currentValue: valorActual.toFixed(2),
                        cashPnl: cashPnl,        // 🟢 NUEVO: Ganancia en USD
                        percentPnl: percentPnl   // 🟢 NUEVO: Porcentaje de ganancia
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

// ==========================================
// 3. ANÁLISIS DE IA (CLAUDE)
// ==========================================
async function analyzeMarketWithClaude(marketQuestion, currentNews) {
    console.log("🧠 Consultando a Claude (Análisis de Mercado)...");
    try {
        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6", // Versión actual recomendada por Anthropic
            max_tokens: 150,
            system: `Eres un Senior Quant Trader especializado en Polymarket. 
            Tu objetivo es encontrar ineficiencias entre las noticias y el precio del mercado.

            Responde ESTRICTAMENTE en JSON con esta estructura:
            {
            "prob": 0.XX,
            "strategy": "MOMENTUM" | "ARBITRAGE" | "TIME_EDGE" | "REVERSAL",
            "urgency": 1-10,
            "reason": "Frase corta de por qué hay ventaja aquí",
            "searchQuery": "3-4 palabras clave para el contrato"
            }

            GUÍAS DE ESTRATEGIA:
            - TIME_EDGE: El evento es casi inevitable y el mercado aún no llega a 0.95+.
            - ARBITRAGE: La noticia confirma el resultado pero el precio se mueve lento.
            - REVERSAL: El mercado entró en pánico por un rumor que el análisis de noticias desmiente.
            - MOMENTUM: La noticia es masiva y el precio va a subir rápido en los próximos minutos.`,
            messages: [{
                role: "user",
                content: `Noticia: ${marketQuestion}. \nContexto: ${currentNews}. \nAnaliza la probabilidad de este mercado.`
            }]
        });

        const jsonMatch = response.content[0].text.match(/\{.*\}/s); 
        if (!jsonMatch) throw new Error("Formato JSON inválido de Claude");

        const data = JSON.parse(jsonMatch[0]);
        return {
            prob: parseFloat(data.prob) || 0,
            reason: data.reason || "Sin descripción.",
            searchQuery: data.searchQuery || marketQuestion
        };
    } catch (error) {
        console.error("❌ Error en Claude:", error.message);
        return { prob: 0, reason: "Error de IA", searchQuery: marketQuestion };
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

async function sendSniperAlert(signal) {
    const edgePct = signal.edge >= 0 ? `+${(signal.edge * 100).toFixed(0)}%` : `${(signal.edge * 100).toFixed(0)}%`;
    const msg = `🎯 *SNIPER GATILLADO*\n\n📋 ${signal.marketName}\n🧠 Probabilidad IA: *${(signal.probability * 100).toFixed(0)}%*\n📊 Precio Mercado: *$${signal.marketPrice}*\n📈 Edge: *${edgePct}*\n💰 Sugerido: *${signal.suggestedInversion} USDC*\n📝 Razón: ${signal.reasoning}`;
    try { await telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); } catch (e) { console.error('❌ Error Telegram:', e.message); }
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

// ==========================================
// 7. ACTUALIZACIÓN DE WATCHLIST (GAMMA API)
// ==========================================
// async function refreshWatchlist() {
//     try {
//         botStatus.currentTopic = 'Escaneando Pilares de Alta Liquidez...';
//         console.log(`\n⏰ [SNIPER] Buscando mercados de Cripto, Geopolítica y Redes Sociales...`);

//         const agent = new https.Agent({ rejectUnauthorized: false });
//         const polyRes = await axios.get(
//             'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500',
//             { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0' } }
//         );

//         if (!polyRes.data || polyRes.data.length === 0) throw new Error('No mercados devueltos');

//         const now = Date.now();
//         const futureMarkets = polyRes.data.filter(m => m.conditionId && m.endDate && new Date(m.endDate).getTime() > now);

//         const targetedMarkets = futureMarkets.map(m => ({ ...m, category: getMarketCategory(m.question) })).filter(m => m.category !== null);

//         targetedMarkets.sort((a, b) => {
//             const isSoonA = hoursUntilClose(a.endDate) <= 48 ? 1 : 0;
//             const isSoonB = hoursUntilClose(b.endDate) <= 48 ? 1 : 0;
//             if (isSoonA !== isSoonB) return isSoonB - isSoonA;
//             return parseFloat(b.volume || 0) - parseFloat(a.volume || 0);
//         });

//         const finalPool = [];
//         const cats = ['CRYPTO', 'GEOPOLITICS', 'SOCIAL'];
//         let idx = 0;
        
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

//         console.log(`⏰ [SNIPER] Pool seleccionado: ${finalPool.length} mercados clave`);

//         const rawTrends = [];
//         for (const market of finalPool) {
//             const hrs = hoursUntilClose(market.endDate);
//             const hrsLabel = hrs < 1 ? `${Math.round(hrs * 60)}min` : hrs < 24 ? `${hrs.toFixed(1)}h` : `${Math.ceil(hrs / 24)}d`;
            
//             let currentPrice = null;
//             if (market.outcomePrices) {
//                 try { currentPrice = parseFloat(JSON.parse(market.outcomePrices)[0]); } catch(e){}
//             }

//             let clobTokenId = null;
//             if (market.clobTokenIds) {
//                 try { clobTokenId = JSON.parse(market.clobTokenIds)[0]; } catch(e){}
//             }

//             rawTrends.push({
//                 title: market.question,
//                 title_es: "Analizando...",
//                 category: market.category,
//                 conditionId: market.conditionId,
//                 tokenId: clobTokenId,
//                 isTradeable: true,
//                 endDate: market.endDate,
//                 endsIn: hrsLabel,
//                 marketPrice: currentPrice
//             });
//             console.log(`🎯 Slot (${market.category}): "${market.question.substring(0, 40)}..." | MKT: $${currentPrice || 0}`);
//         }

//         botStatus.watchlist = rawTrends;
//     } catch (e) { console.error('❌ Error en refreshWatchlist:', e.message); }
// }
async function refreshWatchlist() {
    try {
        botStatus.currentTopic = 'Escaneando Mercados de Alta Probabilidad...';
        console.log(`\n⏰ [SNIPER] Escaneando 500 mercados en busca de ineficiencias...`);

        const agent = new https.Agent({ rejectUnauthorized: false });
        // Añadimos parámetros de ordenamiento por volumen directamente en la API
        const polyRes = await axios.get(
            'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&order=volume&dir=desc',
            { httpsAgent: agent, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );

        if (!polyRes.data || polyRes.data.length === 0) throw new Error('No mercados devueltos');

        const now = Date.now();
        
        // 1. Filtro de Calidad: Debe tener conditionId, fecha futura y VOLUMEN MÍNIMO ($5k)
        const futureMarkets = polyRes.data.filter(m => {
            const hasData = m.conditionId && m.endDate && m.clobTokenIds;
            const isFuture = new Date(m.endDate).getTime() > now;
            const hasLiquidity = parseFloat(m.volume || 0) > 5000; 
            return hasData && isFuture && hasLiquidity;
        });

        // 2. Clasificación por tus 3 Pilares
        const targetedMarkets = futureMarkets.map(m => ({ 
            ...m, 
            category: getMarketCategory(m.question) 
        })).filter(m => m.category !== null);

        // 3. El "Mix" del Sniper: Priorizar lo que cierra pronto
        targetedMarkets.sort((a, b) => {
            const hrsA = hoursUntilClose(a.endDate);
            const hrsB = hoursUntilClose(b.endDate);
            
            // Prioridad máxima a lo que cierra en < 12h (Time-Edge)
            if (hrsA < 12 && hrsB >= 12) return -1;
            if (hrsB < 12 && hrsA >= 12) return 1;
            
            // Si ambos son pronto o ambos son tarde, decidir por volumen
            return parseFloat(b.volume || 0) - parseFloat(a.volume || 0);
        });

        const finalPool = [];
        const cats = ['CRYPTO', 'GEOPOLITICS', 'SOCIAL'];
        let idx = 0;
        
        // Aseguramos diversidad en el pool de 4 slots
        while (finalPool.length < 4 && targetedMarkets.length > 0) {
            const desiredCat = cats[idx % cats.length];
            const matchIdx = targetedMarkets.findIndex(m => m.category === desiredCat);
            if (matchIdx !== -1) {
                finalPool.push(targetedMarkets[matchIdx]);
                targetedMarkets.splice(matchIdx, 1);
            } else if (targetedMarkets.length > 0) {
                finalPool.push(targetedMarkets[0]);
                targetedMarkets.splice(0, 1);
            }
            idx++;
        }

        console.log(`🎯 Pool de Combate: ${finalPool.length} objetivos detectados.`);

        const rawTrends = [];
        for (const market of finalPool) {
            const hrs = hoursUntilClose(market.endDate);
            const hrsLabel = hrs < 1 ? `${Math.round(hrs * 60)}m` : hrs < 24 ? `${hrs.toFixed(1)}h` : `${Math.ceil(hrs / 24)}d`;
            const tickSize = market.minimum_tick_size || "0.01";
            
            let currentPrice = null;
            try { currentPrice = parseFloat(JSON.parse(market.outcomePrices)[0]); } catch(e){}

            let clobTokenId = null;
            try { clobTokenId = JSON.parse(market.clobTokenIds)[0]; } catch(e){}

            rawTrends.push({
                title: market.question,
                title_es: "Esperando análisis de Claude...",
                category: market.category,
                conditionId: market.conditionId,
                tokenId: clobTokenId,
                isTradeable: true,
                endDate: market.endDate,
                endsIn: hrsLabel,
                marketPrice: currentPrice,
                tickSize: tickSize,
                volume: parseFloat(market.volume).toLocaleString()
            });
            console.log(`📡 [${market.category}] $${currentPrice || '?' } | Vol: $${parseFloat(market.volume).toFixed(0)} | Q: "${market.question.substring(0, 35)}..."`);
        }

        botStatus.watchlist = rawTrends;
    } catch (e) { console.error('❌ Error Sniper Watchlist:', e.message); }
}

// ==========================================
// 8. EJECUCIÓN DE COMPRA (CORREGIDA)
// ==========================================
// Agregamos marketTickSize como parámetro (con "0.01" por defecto por seguridad)
async function executeTradeOnChain(conditionId, tokenId, amountUsdc, currentPrice, marketTickSize = "0.01") {
    try {
        console.log(`\n--- ⚖️ EJECUCIÓN ON-CHAIN EN POLYMARKET ---`);

        if (!clobClient) {
            throw new Error("clobClient no está inicializado. Llama primero a conectarClob()");
        }

        // 1. Ajuste de decimales según el Tick Size del mercado
        const decimales = marketTickSize === "0.001" ? 3 : 2;
        const finalPrice = Number(parseFloat(currentPrice).toFixed(decimales));
        
        // 2. Cálculo preciso para evitar el error de "min size $1"
        let numShares = Number((parseFloat(amountUsdc) / finalPrice).toFixed(2));
        if (numShares * finalPrice < 1) {
            console.log("⚠️ Ajustando orden para superar el mínimo de $1 USDC");
            numShares = Math.ceil(1.05 / finalPrice); 
        }

        console.log(`📡 Creando orden BUY: ${numShares} shares @ $${finalPrice} (Tick: ${marketTickSize})`);

        // 3. Usamos la variable dinámica en lugar del texto fijo
        const response = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: finalPrice,
                side: Side.BUY,
                size: numShares,
            },
            { 
                tickSize: marketTickSize, // <--- AHORA ES DINÁMICO
                negRisk: false      
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
        if (error.response?.data) console.error("Detalles del error:", error.response.data);
        throw error;
    }
}

// ==========================================
// 9. Función para recuperar trades reales
// ==========================================

async function fetchRealTrades() {
    const PROXY_WALLET = "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
    try {
        console.log("📡 Recuperando historial y calculando Valor en vivo...");
        
        // Esta API es la que sí te trae los nombres legibles
        const response = await axios.get(
            `https://data-api.polymarket.com/trades?user=${PROXY_WALLET}&limit=10`, 
            { httpsAgent: agent }
        );

        const rawTrades = response.data.data || response.data.trades || response.data;

        if (Array.isArray(rawTrades) && rawTrades.length > 0) {
            botStatus.executions = await Promise.all(rawTrades.map(async (trade) => {
                const hash = trade.transaction_hash || trade.id || "0x0000000000";
                const title = trade.title || trade.asset_id || "Mercado Polymarket";
                
                const shares = parseFloat(trade.size || 0); // "Pago Potencial"
                const buyPrice = parseFloat(trade.price || 0); // "Cuota"
                const inversionReal = shares * buyPrice; // "Apuesta"

                // --- 🎯 CÁLCULO DE VALOR ACTUAL (PRECISIÓN MILIMÉTRICA) ---
                const tokenId = trade.asset_id || trade.token_id;
                let currentPrice = 0;
                
                try {
                    // 1. Buscamos el mejor precio de venta real en el Orderbook (Best Bid)
                    const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, { httpsAgent: agent });
                    
                    if (bookResp.data && bookResp.data.bids && bookResp.data.bids.length > 0) {
                        currentPrice = parseFloat(bookResp.data.bids[0].price);
                    } else {
                        // 2. Si el libro está vacío, buscamos el último precio operado
                        const priceResp = await axios.get(`https://clob.polymarket.com/price?token_id=${tokenId}`, { httpsAgent: agent });
                        currentPrice = parseFloat(priceResp.data.price || 0);
                    }
                } catch (e) {
                    // Si ambas fallan, el mercado está cerrado/liquidado
                    currentPrice = 0;
                }

                const valorActual = shares * currentPrice;
                const gananciaAbsoluta = valorActual - inversionReal;
                const pnlPercentage = inversionReal > 0 ? ((valorActual / inversionReal) - 1) * 100 : 0;

                // Definimos si el mercado sigue vivo o ya expiró
                // Si el precio es 0, asumimos que terminó. Si tiene valor, sigue activo.
                const estadoOperacion = currentPrice === 0 && inversionReal > 0 ? "FINALIZADO 🏁" : "ACTIVO 🟢";

                return {
                    id: hash.toString().substring(0, 10),
                    tokenId: tokenId,
                    time: trade.timestamp ? new Date(trade.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString(),
                    market: title.length > 40 ? title.substring(0, 40) + "..." : title, // <--- EL NOMBRE REAL
                    
                    price: buyPrice,               
                    inversion: inversionReal,      
                    pagoPotencial: shares,         
                    
                    valorActual: valorActual,      // <--- EL VALOR REAL (Ej. $0.70)
                    pnlUsdc: gananciaAbsoluta,     
                    pnlPct: pnlPercentage,         
                    
                    status: estadoOperacion
                };
            }));
            console.log(`📊 Dashboard actualizado: Nombres y Valores reales sincronizados.`);
        }
    } catch (e) {
        console.error("❌ Error actualizando trades:", e.message);
    }
}

// ==========================================
// 10. CICLO PRINCIPAL (EL CEREBRO DEL BOT)
// ==========================================
let watchlistIndex = 0;

async function runBot() {
    if (botStatus.isPanicStopped) return;

    botStatus.lastCheck = new Date().toLocaleTimeString();
    try {
        // CAPA 1: Actualizar lo que ya tenemos (Gratis - Sin IA)
        await fetchRealTrades();
        await updateRealBalances();

        // Gestionar Ventas Automáticas (Si hay ganancias > 15% o pérdidas > 10%)
        if (botStatus.autoTradeEnabled) {
            await autoSellManager();
        }

        // CAPA 2: Rotación de Watchlist
        if (botStatus.watchlist.length === 0 || watchlistIndex >= botStatus.watchlist.length) {
            await refreshWatchlist();
            watchlistIndex = 0;
        }

        const marketItem = botStatus.watchlist[watchlistIndex];
        const marketTitle = marketItem.title;

        // CAPA 3: ¿Realmente necesitamos a Claude? (Ahorro de tokens)
        const newsString = await getLatestNews(marketTitle, marketItem.category);
        const cacheKey = `${marketItem.tokenId}-${newsString.substring(0, 50)}`;

        let prob;
        if (analysisCache.has(cacheKey)) {
            console.log(`♻️ Usando análisis en caché para: ${marketTitle.substring(0, 30)}`);
            prob = analysisCache.get(cacheKey);
        } else {
            // Solo gastamos créditos si las noticias cambiaron
            const analysis = await analyzeMarketWithClaude(marketTitle, newsString);
            prob = analysis.prob;
            analysisCache.set(cacheKey, prob);
            // Limpiar cache viejo si crece mucho
            if (analysisCache.size > 50) analysisCache.delete(analysisCache.keys().next().value);
        }

        botStatus.lastProbability = prob;
        const livePrice = marketItem.marketPrice || 0;
        const edge = prob - livePrice;

        // LÓGICA DE DISPARO AUTOMÁTICO
        if (botStatus.autoTradeEnabled && edge >= 0.12 && prob >= botStatus.predictionThreshold) {
            console.log(`🎯 SNIPER: Edge detectado del ${(edge*100).toFixed(0)}%. Disparando...`);
            
            const result = await executeTradeOnChain(
                marketItem.conditionId, 
                marketItem.tokenId, 
                botStatus.microBetAmount, 
                livePrice,
                marketItem.tickSize
            );

            // 🟢 NUEVO: ALERTA DE TELEGRAM PARA COMPRAS AUTOMÁTICAS
            if (result && result.success) {
                await sendAlert(`🤖 *COMPRA AUTOMÁTICA (SNIPER)*\nMercado: ${marketItem.title}\nInversión: $${botStatus.microBetAmount} USDC\nPrecio MKT: $${livePrice}\nIA Confianza: ${(prob*100).toFixed(0)}%`);
                await updateRealBalances(); // Refrescamos el frontend
            }
        }

        watchlistIndex++;
    } catch (error) {
        console.error('❌ Error en ciclo Sniper:', error.message);
    }
}

async function autoSellManager() {
    for (const pos of botStatus.activePositions) {
        // 🛑 FIX 404: Si el mercado ya cerró, lo ignoramos para no romper la API
        if (pos.status.includes('CANJEAR')) continue;

        const profit = pos.percentPnl || 0;
        
        // ESTRATEGIA: Vender si ganamos 20% o si perdemos 15% (Stop Loss)
        if (profit >= 20 || profit <= -15) {
            console.log(`💰 AUTO-SELL: Cerrando ${pos.marketName} con ${profit}% PnL`);
            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { httpsAgent: agent });
                if (bookResp.data?.bids?.length > 0) {
                    const bestBid = parseFloat(bookResp.data.bids[0].price);
                    await clobClient.createAndPostOrder({
                        tokenID: pos.tokenId,
                        price: bestBid,
                        side: Side.SELL,
                        size: pos.exactSize
                    });
                    await sendAlert(`📉 *VENTA AUTOMÁTICA*\nMercado: ${pos.marketName}\nResultado: ${profit.toFixed(2)}%`);
                    await updateRealBalances(); // <-- Refrescamos saldos
                }
            } catch (e) {
                console.error("Error en auto-venta:", e.message);
            }
        }
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

        if (!botStatus.activePositions || botStatus.activePositions.length === 0) return;

        let posicionesGanadoras = [];
        let totalPnl = 0;

        for (const pos of botStatus.activePositions) {
            // Solo evaluamos los que están vivos
            if (pos.status.includes('ACTIVO')) {
                totalPnl += (pos.cashPnl || 0);
                
                // 🔥 LA REGLA DE ORO: Si la ganancia supera el 5%, ¡avisa!
                if (pos.percentPnl && pos.percentPnl >= 5.0) {
                    posicionesGanadoras.push(
                        `📈 *${pos.marketName.substring(0,35)}...*\n` +
                        `Valor Actual: *$${pos.currentValue} USDC*\n` +
                        `Ganancia: *+$${pos.cashPnl.toFixed(2)} (+${pos.percentPnl.toFixed(1)}%)*`
                    );
                }
            }
        }

        // Si encontró posiciones jugosas, dispara el mensaje a Telegram
        if (posicionesGanadoras.length > 0) {
            const alerta = `🚨 *ALERTA DE TOMA DE GANANCIAS* 🚨\nTienes posiciones en verde listas para operar:\n\n${posicionesGanadoras.join('\n\n')}\n\n💵 *PnL Global Flotante: $${totalPnl.toFixed(2)}*`;
            await sendAlert(alerta);
        }

    } catch (error) {
        console.error("❌ Error en monitorPortfolio:", error.message);
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
    const { enabled, amount } = req.body;
    
    if (enabled !== undefined) botStatus.autoTradeEnabled = !!enabled;
    if (amount !== undefined) botStatus.microBetAmount = parseFloat(amount) || botStatus.microBetAmount;
    
    console.log(`\n⚙️ [CONTROL] Gatillo Sniper: ${botStatus.autoTradeEnabled ? 'ENCENDIDO 🟢' : 'APAGADO 🔴'} | Calibre: $${botStatus.microBetAmount} USDC`);
    
    res.json({ 
        success: true, 
        autoTradeEnabled: botStatus.autoTradeEnabled, 
        microBetAmount: botStatus.microBetAmount 
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