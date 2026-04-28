// services/polymarketService.js
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import axios from 'axios';
import { USDC_ADDRESS, PROXY_WALLET, API_ENDPOINTS } from '../constants.js';
import { botStatus } from '../config.js';

let clobClient = null;

export async function initCLOB(wallet) {
    try {
        console.log("🔐 Autenticando con Polymarket...");
        const authClient = new ClobClient(API_ENDPOINTS.CLOB_BASE, 137, wallet);
        const apiCreds = await authClient.createOrDeriveApiKey();

        clobClient = new ClobClient(
            API_ENDPOINTS.CLOB_BASE,
            137,
            wallet,
            apiCreds,
            2,
            PROXY_WALLET
        );

        console.log("✅ CLOB Client conectado correctamente");
        console.log(`   - Funder (Proxy): ${PROXY_WALLET}`);
        return clobClient;
    } catch (error) {
        console.error("❌ Error conectando CLOB:", error.message);
        throw error;
    }
}

// ==========================================
// 8. EJECUCIÓN DE COMPRA - VERSIÓN ANTI "CROSSES THE BOOK"
// ==========================================
export async function executeTradeOnChain(conditionId, tokenId, amountUsdc, currentPrice, marketTickSize = "0.01") {
    try {
        console.log(`\n--- ⚖️ EJECUCIÓN ON-CHAIN EN POLYMARKET ---`);
        console.log(`🎯 Token: ${tokenId.substring(0,12)}... | Monto: $${amountUsdc} | Precio base: $${currentPrice}`);

        if (!clobClient) throw new Error("clobClient no está inicializado.");

        // 1. Obtener Orderbook fresco para evitar "crosses the book"
        let bookData;
        try {
            const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
                httpsAgent: agent, timeout: 8000
            });
            bookData = bookResp.data;
        } catch (e) {
            console.log("⚠️ No se pudo obtener orderbook, usando precio base.");
        }

        let trueTickSize = marketTickSize;
        let isNegRisk = false;
        let minOrderSize = 5;

        // Datos del mercado
        try {
            const marketInfo = await axios.get(`https://clob.polymarket.com/markets/${conditionId}`);
            if (marketInfo.data) {
                isNegRisk = marketInfo.data.neg_risk === true;
                if (marketInfo.data.minimum_order_size) minOrderSize = parseFloat(marketInfo.data.minimum_order_size);
            }
        } catch (e) {}

        // ====================== CÁLCULO INTELIGENTE DE PRECIO ======================
        let basePrice = parseFloat(currentPrice);
        
        // Si tenemos asks, usamos el mejor Ask como referencia
        if (bookData?.asks && bookData.asks.length > 0) {
            const bestAsk = parseFloat(bookData.asks[0].price);
            console.log(`📊 Best Ask actual: $${bestAsk}`);
            
            if (bestAsk > 0) {
                basePrice = Math.max(basePrice, bestAsk); // Nunca compres más barato que el Ask
            }
        }

        const entrySlippagePct = botStatus.riskSettings.entrySlippage || 5;
        let limitPrice = basePrice * (1 + entrySlippagePct / 100);
        
        if (limitPrice > 0.99) limitPrice = 0.99;
        limitPrice = Number(limitPrice.toFixed(4)); // Más precisión

        console.log(`📡 Precio final con slippage: $${limitPrice} (slippage ${entrySlippagePct}%)`);

        // ====================== CÁLCULO DE SHARES ======================
        let targetAmount = parseFloat(amountUsdc);
        let numShares = Number((targetAmount / limitPrice).toFixed(4));

        if (numShares < minOrderSize) {
            numShares = minOrderSize;
            console.log(`⚠️ Ajustando al mínimo del mercado: ${minOrderSize} shares`);
        }

        console.log(`📡 Orden BUY: ${numShares} shares | Precio: $${limitPrice} | Monto: $${(numShares * limitPrice).toFixed(2)}`);

        const response = await clobClient.createAndPostOrder(
            {
                tokenID: tokenId,
                price: limitPrice,
                side: Side.BUY,
                size: numShares,
            },
            { 
                tickSize: String(trueTickSize), 
                negRisk: isNegRisk 
            }, 
            OrderType.GTC
        );

        if (response && response.success) {
            console.log(`🎉 ¡ORDEN ACEPTADA! Order ID: ${response.orderID}`);
            return { success: true, hash: response.orderID };
        } else {
            console.log(`❌ Orden rechazada:`, JSON.stringify(response));
            throw new Error(`Orden rechazada: ${JSON.stringify(response)}`);
        }

    } catch (error) {
        console.error("❌ Error en executeTradeOnChain:", error.message);
        if (error.response?.data) {
            console.error("   Detalle API:", JSON.stringify(error.response.data));
        }
        throw error;
    }
}

// ==========================================
// 8.5 EJECUCIÓN DE VENTA (VERSIÓN ULTRA DEBUG)
// ==========================================
const recentlySoldTokens = new Set();

export async function executeSellOnChain(conditionId, tokenId, exactShares, limitPrice, marketTickSize = "0.01") {
    try {
        console.log(`\n🔴 [EXECUTE SELL DEBUG] Iniciando venta para token: ${tokenId.substring(0,12)}...`);
        console.log(`   Shares solicitados: ${exactShares} | Precio límite: $${limitPrice}`);

        if (recentlySoldTokens.has(tokenId)) {
            console.log(`      ⏳ Token en cooldown. Venta ignorada.`);
            return { success: false, reason: "COOLDOWN_ACTIVE" };
        }

        let sharesToSell = parseFloat(exactShares);
        if (sharesToSell <= 0) {
            console.log(`❌ [SELL] Shares inválidos: ${sharesToSell}`);
            return { success: false, reason: "NO_SHARES" };
        }

        // === VERIFICACIÓN DE SALDO REAL ===
        let realBalance = 0;
        let balanceChecked = false;
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=50`);
            
            if (response.ok) {
                const positions = await response.json();
                const targetPos = positions.find(p => p.asset === tokenId || p.token_id === tokenId);
                realBalance = targetPos ? parseFloat(targetPos.size || 0) : 0;
                balanceChecked = true;
                console.log(`📊 [SELL] Saldo real API: ${realBalance} shares`);
            }
        } catch (e) {
            console.log("⚠️ No se pudo verificar saldo real en API.");
        }

        if (balanceChecked) {
            if (realBalance === 0) {
                console.log(`👻 [SELL] POSICIÓN FANTASMA (Saldo Real = 0). Abortando venta.`);
                recentlySoldTokens.add(tokenId);
                setTimeout(() => recentlySoldTokens.delete(tokenId), 60000);
                return { success: false, reason: "ZERO_REAL_BALANCE" };
            }
            if (sharesToSell > realBalance) {
                console.log(`⚠️ [SELL] Ajustando shares: ${sharesToSell} → ${realBalance} (saldo real)`);
                sharesToSell = realBalance;
            }
        }

        sharesToSell = Math.max(0, Math.floor((sharesToSell - 0.01) * 100) / 100);

        if (sharesToSell <= 0) {
            console.log(`❌ [SELL] Cantidad final después de ajustes = 0`);
            recentlySoldTokens.add(tokenId);
            return { success: false, reason: "LOW_BALANCE" };
        }

        // === CONFIGURACIÓN DE PRECIO Y TICK ===
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

        console.log(`📡 [SELL] Orden FINAL: ${sharesToSell} shares | Precio: $${safeLimitPrice} | Tick: ${trueTickSize}`);

        // === EJECUCIÓN REAL ===
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
            console.log(`🎉 [SELL ÉXITO] Orden aceptada! Order ID: ${response.orderID}`);
            recentlySoldTokens.add(tokenId);
            setTimeout(() => recentlySoldTokens.delete(tokenId), 3 * 60 * 1000);
            return { success: true, hash: response.orderID };
        } else {
            console.log(`❌ [SELL RECHAZADA] Respuesta:`, JSON.stringify(response));
            throw new Error(`Orden rechazada: ${JSON.stringify(response)}`);
        }

    } catch (error) {
        console.error(`❌ [EXECUTE SELL ERROR] ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status} | Data:`, error.response.data);
        }
        throw error;
    }
}

export async function getMarketPrice(tokenId) {
    if (!tokenId) return null;
    try {
        const url = `${API_ENDPOINTS.CLOB_BASE}/midpoint?token_id=${tokenId}`;
        const response = await axios.get(url);
        return response.data?.mid ? parseFloat(response.data.mid).toFixed(3) : null;
    } catch (e) {
        console.error("❌ Error obteniendo precio CLOB:", e.message);
        return null;
    }
}

// ==========================================
// 9. Función para recuperar trades reales
// ==========================================
export async function fetchRealTrades() {
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

export async function getCurrentPositionValue(tokenId) {
    if (!tokenId) return 0;
    try {
        const userAddress = process.env.POLY_PROXY_ADDRESS || PROXY_WALLET;
        const response = await axios.get(
            `${API_ENDPOINTS.DATA_API}/positions?user=${userAddress}&limit=100`
        );
        const pos = response.data?.find(p => p.asset === tokenId || p.token_id === tokenId);
        return pos ? parseFloat(pos.currentValue || pos.value || 0) : 0;
    } catch (e) {
        return 0;
    }
}