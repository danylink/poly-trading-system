// engines/shared/equalizerLogic.js
import { botStatus } from '../../config.js';
import { executeTradeOnChain } from '../../services/polymarketService.js';
import { getMarketPrice } from '../../services/polymarketService.js';
import { sendSniperAlert } from '../../services/telegramService.js';
import { analyzeMarketWithClaude, analyzeMarketWithGemini, analyzeMarketWithGrok } from '../../utils/ia.js';
import { pendingOrdersCache } from '../../utils/memory.js';
import { saveConfigToDisk } from '../../config.js';

// ==========================================
// ANALIZADOR DE SHOCKS DE LIQUIDEZ
// ==========================================
export async function checkForLiquidityShocks() {
    if (!botStatus.equalizerEnabled || botStatus.isPanicStopped) return;

    console.log(`🔍 [EQUALIZER SCAN] Revisando ${Object.keys(priceHistoryCache).length} tokens...`);

    for (const tokenId in priceHistoryCache) {
        const history = priceHistoryCache[tokenId];
        if (history.length < 2) continue;

        const currentEntry = history[history.length - 1];
        const oldestEntry = history[0];

        const currentPrice = currentEntry.price;
        const oldestPrice = oldestEntry.price;
        
        const changePct = ((currentPrice - oldestPrice) / oldestPrice) * 100;

        console.log(`   → Token ${tokenId.slice(0,8)}... | ${oldestPrice.toFixed(4)} → ${currentPrice.toFixed(4)} | Cambio: ${changePct.toFixed(1)}%`);

        if (Math.abs(changePct) >= botStatus.equalizerShockThreshold) {
            console.log(`🚨 [EQUALIZER SHOCK DETECTADO!] ${changePct.toFixed(1)}% en ${tokenId.slice(0,8)}`);
            
            const fullMarket = botStatus.watchlist.find(m => m.tokenYes === tokenId || m.tokenNo === tokenId);
            if (!fullMarket) continue;

            const isYesToken = (fullMarket.tokenYes === tokenId);
            const eventProbabilityChange = isYesToken ? changePct : -changePct;

            let outcomeToBuy;
            if (changePct > 0) {
                outcomeToBuy = isYesToken ? "NO" : "YES";
            } else {
                outcomeToBuy = isYesToken ? "YES" : "NO";
            }

            const targetTokenId = outcomeToBuy === "YES" ? fullMarket.tokenYes : fullMarket.tokenNo;

            const alreadyInvested = botStatus.activePositions.some(p => p.tokenId === targetTokenId);
            const alreadyPending = pendingOrdersCache.has(targetTokenId);

            if (alreadyInvested || alreadyPending) continue;

            console.log(`🚨 [SHOCK DETECTADO] ${fullMarket.title}`);

            // Verificar con IA
            await verifyShockWithIA(fullMarket, eventProbabilityChange, currentPrice, targetTokenId, outcomeToBuy);
        }
    }
}

// ==========================================
// VERIFICACIÓN CON IA
// ==========================================
export async function verifyShockWithIA(marketData, eventProbabilityChange, triggerPrice, shockTokenId, outcomeToBuy) {
    const direction = eventProbabilityChange > 0 ? "AUMENTADO" : "CAÍDO";
    const newsString = await getLatestNews(marketData.title, marketData.category || "");

    const flashPrompt = `
[ALERTA DE SHOCK DE LIQUIDEZ]: La probabilidad del evento "${marketData.title}" ha ${direction} un ${Math.abs(eventProbabilityChange).toFixed(1)}% en pocos minutos.
Noticias: "${newsString || 'Sin noticias relevantes'}"

¿Es pánico irracional o movimiento justificado? Responde en JSON con "recommendation": "BUY" o "WAIT".
`;

    try {
        let result;
        const claudeRes = await analyzeMarketWithClaude(marketData.title, flashPrompt, 1);

        if (!claudeRes.isError) {
            result = { 
                isJustified: claudeRes.recommendation !== "WAIT", 
                reason: claudeRes.reason, 
                confidence: (claudeRes.prob * 100) || 75 
            };
        } else {
            const grokRes = await analyzeMarketWithGrok(marketData.title, flashPrompt, 1);
            result = { 
                isJustified: grokRes.recommendation !== "WAIT", 
                reason: grokRes.reason, 
                confidence: (grokRes.prob * 100) || 75 
            };
        }

        if (!result.isJustified && result.confidence >= 70) {
            console.log(`📉 [EQUALIZER] IA confirma PÁNICO. Procediendo a comprar contraparte.`);

            const currentLivePrice = await getMarketPrice(shockTokenId) || triggerPrice;
            const expectedDiscount = outcomeToBuy === "YES" ? triggerPrice : (1 - triggerPrice);

            if (parseFloat(currentLivePrice) > expectedDiscount + 0.03) {
                console.log(`⚠️ [EQUALIZER] Precio ya se corrigió. Abortando.`);
                return;
            }

            await executeEqualizerTrade(marketData, outcomeToBuy);
        } else {
            console.log(`⏩ [EQUALIZER] Movimiento justificado. Ignorando.`);
        }
    } catch (err) {
        console.error("❌ Error en verifyShockWithIA:", err.message);
    }
}

// ==========================================
// EJECUCIÓN DEL TRADE EQUALIZER
// ==========================================
export async function executeEqualizerTrade(marketData, outcomeToBuy) {
    try {
        const fullMarket = botStatus.watchlist.find(m => m.title === marketData.title);
        if (!fullMarket) return;

        const targetTokenId = outcomeToBuy === "YES" ? fullMarket.tokenYes : fullMarket.tokenNo;

        if (botStatus.activePositions.some(p => p.tokenId === targetTokenId) || pendingOrdersCache.has(targetTokenId)) {
            return;
        }

        const targetPrice = outcomeToBuy === "YES" ? fullMarket.priceYes : fullMarket.priceNo;
        const betAmount = botStatus.equalizerBetAmount || 5;

        if (parseFloat(botStatus.clobOnlyUSDC || 0) < betAmount) return;

        const result = await executeTradeOnChain(
            fullMarket.conditionId,
            targetTokenId,
            betAmount,
            targetPrice,
            fullMarket.tickSize || "0.01"
        );

        if (result?.success) {
            pendingOrdersCache.add(targetTokenId);
            setTimeout(() => pendingOrdersCache.delete(targetTokenId), 60000);

            botStatus.positionEngines[targetTokenId] = "EQUALIZER";
            botStatus.lastTrades[targetTokenId] = Date.now();

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
                engine: "EQUALIZER"
            });

            saveConfigToDisk("Disparo Quantum Equalizer");

            await sendSniperAlert({
                marketName: `🌊 [EQUALIZER] ${fullMarket.title} (${outcomeToBuy})`,
                probability: outcomeToBuy === "YES" ? 0.99 : 0.01,
                marketPrice: targetPrice,
                edge: botStatus.equalizerShockThreshold / 100,
                suggestedInversion: betAmount,
                reasoning: "Shock de liquidez detectado + IA confirma pánico irracional.",
                engine: "Quantum Equalizer"
            });
        }
    } catch (error) {
        console.error(`❌ [EQUALIZER TRADE ERROR]:`, error.message);
    }
}

// ==========================================
// ALIMENTADOR DE MEMORIA (High Frequency Radar)
// ==========================================
export async function updateHighFrequencyRadar() {
    if (!botStatus.equalizerEnabled) return;

    try {
        botStatus.watchlist.forEach(market => {
            if (market.priceYes) recordPriceToMemory(market.tokenYes, market.priceYes);
            if (market.priceNo) recordPriceToMemory(market.tokenNo, market.priceNo);
        });
    } catch (e) {
        console.error("❌ Error en updateHighFrequencyRadar:", e.message);
    }
}