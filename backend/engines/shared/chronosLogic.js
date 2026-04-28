// engines/shared/chronosLogic.js
import { botStatus } from '../../config.js';
import { executeTradeOnChain } from '../../services/polymarketService.js';
import { getMarketPrice } from '../../services/polymarketService.js';
import { sendAlert } from '../../services/telegramService.js';
import { analyzeMarketWithClaude, analyzeMarketWithGrok } from '../../utils/ia.js';
import { getLatestNews } from '../../utils/helpers.js';           // ← Asegúrate de tener esta función
import { pendingOrdersCache, closedPositionsCache } from '../../utils/memory.js';
import { saveConfigToDisk } from '../../config.js';

export async function runChronosHarvester() {
    console.log(`\n⏳ [CHRONOS DEBUG] === INICIANDO ESCANEO === Enabled: ${botStatus.chronosEnabled}`);

    if (!botStatus.chronosEnabled || botStatus.isPanicStopped) {
        console.log(`⏳ [CHRONOS] Desactivado o en modo pánico`);
        return;
    }

    if (!botStatus.watchlist || botStatus.watchlist.length === 0) {
        console.log(`⚠️ [CHRONOS] Watchlist vacía. Esperando próxima ejecución...`);
        return;
    }

    console.log(`⏳ [CHRONOS] Revisando ${botStatus.watchlist.length} mercados | Rango NO: ${botStatus.chronosMinPrice} - ${botStatus.chronosMaxPrice}`);

    const now = Date.now();
    let candidatesFound = 0;

    for (const market of botStatus.watchlist) {
        if (!market.endDate || !market.priceNo || !market.tokenNo) continue;

        const endTime = new Date(market.endDate).getTime();
        const hoursLeft = (endTime - now) / (1000 * 60 * 60);

        // Filtro principal
        if (hoursLeft <= 0 || hoursLeft > botStatus.chronosHoursLeft) continue;
        if (market.priceNo < botStatus.chronosMinPrice || market.priceNo > botStatus.chronosMaxPrice) continue;

        candidatesFound++;

        const alreadyInvested = botStatus.activePositions.some(p => p.tokenId === market.tokenNo);
        const alreadyPending = pendingOrdersCache.has(market.tokenNo);
        const alreadyClosed = closedPositionsCache.has(market.tokenNo);

        if (alreadyInvested || alreadyPending || alreadyClosed) {
            console.log(`   ⏭️ [CHRONOS] Ya tenemos posición en: ${market.title.substring(0,60)}...`);
            continue;
        }

        const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
        if (saldoLibre < botStatus.chronosBetAmount) {
            console.log(`   ⚠️ [CHRONOS] Saldo insuficiente para disparo`);
            continue;
        }

        console.log(`⏳ [CHRONOS DETECTADO] ${market.title} | Precio NO: $${market.priceNo} | Expira en: ${hoursLeft.toFixed(1)}h`);

        const newsString = await getLatestNews(market.title, market.category || "");

        // 🔥 PROMPT MEJORADO
        const chronosPrompt = `
Eres un experto en Theta Decay en Polymarket.

Mercado: "${market.title}"
Precio actual del NO: $${market.priceNo}
Horas restantes: ${hoursLeft.toFixed(1)}h

Noticias recientes: "${newsString || 'Sin noticias relevantes'}"

INSTRUCCIÓN CLARA:
- Si el evento tiene poca probabilidad de ocurrir en las últimas horas (noticias débiles, evento olvidado, o sin catalizadores), responde con recommendation = "WAIT" (significa que es seguro comprar el NO).
- Solo responde "BUY" si hay evidencia fuerte de que el evento sucederá pronto.
- Sé más agresivo que conservador en mercados cercanos a expiración.
Responde en formato JSON.
`;

        try {
            let result;
            const claudeRes = await analyzeMarketWithClaude(market.title, chronosPrompt, 1);

            if (!claudeRes.isError) {
                result = { 
                    isDead: claudeRes.recommendation === "WAIT" || 
                            claudeRes.reason.toLowerCase().includes("muerto") ||
                            claudeRes.reason.toLowerCase().includes("improbable") ||
                            claudeRes.reason.toLowerCase().includes("olvidado"),
                    reason: claudeRes.reason, 
                    confidence: (claudeRes.prob * 100) || 80 
                };
            } else {
                const grokRes = await analyzeMarketWithGrok(market.title, chronosPrompt, 1);
                if (!grokRes.isError) {
                    result = { 
                        isDead: grokRes.recommendation === "WAIT" || 
                                grokRes.reason.toLowerCase().includes("muerto"),
                        reason: grokRes.reason, 
                        confidence: (grokRes.prob * 100) || 80 
                    };
                } else {
                    console.log(`   ⚠️ [CHRONOS] Ambas IAs fallaron`);
                    continue;
                }
            }

            if (result.isDead && result.confidence >= 70) {
                console.log(`📉 [CHRONOS] IA Confirma Evento Muerto → Comprando NO. Razón: ${result.reason}`);

                const currentLivePrice = await getMarketPrice(market.tokenNo) || market.priceNo;

                if (parseFloat(currentLivePrice) > market.priceNo + 0.04) {
                    console.log(`⚠️ [CHRONOS] Precio subió demasiado. Abortando.`);
                    continue;
                }

                const tradeResult = await executeTradeOnChain(
                    market.conditionId, 
                    market.tokenNo, 
                    botStatus.chronosBetAmount, 
                    currentLivePrice, 
                    market.tickSize || "0.01"
                );

                if (tradeResult?.success) {
                    pendingOrdersCache.add(market.tokenNo);
                    setTimeout(() => pendingOrdersCache.delete(market.tokenNo), 60000);

                    botStatus.lastTrades[market.tokenNo] = Date.now();
                    botStatus.positionEngines[market.tokenNo] = "CHRONOS";

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

                    await sendAlert(
                        `⏳ CHRONOS HARVESTER\n` +
                        `🎯 ${market.title}\n` +
                        `🛒 Compra: *NO* a $${currentLivePrice}\n` +
                        `💰 Monto: $${botStatus.chronosBetAmount}\n` +
                        `⏰ Expira en: ${hoursLeft.toFixed(1)}h\n` +
                        `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
                    );

                    console.log(`✅ [CHRONOS] ¡Disparo exitoso!`);
                }
            } else {
                console.log(`⏩ [CHRONOS] Peligro: El evento podría ocurrir. Ignorando.`);
            }
        } catch (err) {
            console.error(`❌ Error en Chronos IA para ${market.title}:`, err.message);
        }
    }

    if (candidatesFound === 0) {
        console.log(`⏳ [CHRONOS] No se encontraron mercados que cumplan los criterios esta vez.`);
    }
}