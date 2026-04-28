// engines/shared/kineticLogic.js
import { botStatus } from '../../config.js';
import { executeTradeOnChain } from '../../services/polymarketService.js';
import { sendAlert } from '../../services/telegramService.js';
import { pendingOrdersCache, closedPositionsCache } from '../../utils/memory.js';
import { saveConfigToDisk } from '../../config.js';

export async function runKineticPressureScanner() {
    if (!botStatus.kineticEnabled || botStatus.isPanicStopped) return;

    // Verificar límite de posiciones Kinetic
    const kineticActiveCount = botStatus.activePositions.filter(p => p.engine === 'KINETIC').length;
    if (kineticActiveCount >= botStatus.kineticMaxPositions) {
        return;
    }

    // Solo los mercados con más volumen
    const topMarkets = [...botStatus.watchlist]
        .sort((a, b) => (b.volume || 0) - (a.volume || 0))
        .slice(0, 5);

    for (const market of topMarkets) {
        try {
            // Obtener Orderbook
            const bookResp = await axios.get(
                `https://clob.polymarket.com/book?token_id=${market.tokenYes}`,
                { timeout: 5000 }
            );

            const bids = bookResp.data?.bids || [];
            const asks = bookResp.data?.asks || [];

            if (bids.length === 0 || asks.length === 0) continue;

            const midPrice = (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2;
            const range = (botStatus.kineticDepthPercent || 2) / 100;

            // Presión de compra vs venta
            const buyPressure = bids
                .filter(b => parseFloat(b.price) >= midPrice * (1 - range))
                .reduce((sum, b) => sum + (parseFloat(b.size) * parseFloat(b.price)), 0);

            const sellPressure = asks
                .filter(a => parseFloat(a.price) <= midPrice * (1 + range))
                .reduce((sum, a) => sum + (parseFloat(a.size) * parseFloat(a.price)), 0);

            const currentRatio = buyPressure / (sellPressure || 1);

            if (currentRatio >= (botStatus.kineticImbalanceRatio || 8)) {
                // Candados de seguridad
                if (botStatus.activePositions.some(p => p.tokenId === market.tokenYes)) continue;
                if (pendingOrdersCache.has(market.tokenYes)) continue;
                if (closedPositionsCache.has(market.tokenYes)) continue;

                const saldoLibre = parseFloat(botStatus.clobOnlyUSDC || 0);
                if (saldoLibre < botStatus.kineticBetAmount) continue;

                console.log(`🌊 [KINETIC DETECTADO] Presión extrema en ${market.title}`);
                console.log(`📊 Ratio: ${currentRatio.toFixed(1)}:1 | Buy: $${buyPressure.toFixed(0)} | Sell: $${sellPressure.toFixed(0)}`);

                const targetPrice = parseFloat(asks[0].price);
                const tradeResult = await executeTradeOnChain(
                    market.conditionId,
                    market.tokenYes,
                    botStatus.kineticBetAmount,
                    targetPrice,
                    market.tickSize || "0.01"
                );

                if (tradeResult?.success) {
                    pendingOrdersCache.add(market.tokenYes);
                    setTimeout(() => pendingOrdersCache.delete(market.tokenYes), 60000);

                    botStatus.positionEngines[market.tokenYes] = "KINETIC";
                    botStatus.lastTrades[market.tokenYes] = Date.now();

                    // Agregar al dashboard
                    botStatus.activePositions.push({
                        tokenId: market.tokenYes,
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

                    await sendAlert(
                        `🌊 *KINETIC PRESSURE (BUY)*\n\n` +
                        `🎯 ${market.title}\n` +
                        `📊 Ratio de presión: *${currentRatio.toFixed(1)}:1*\n` +
                        `💰 Inversión: *$${botStatus.kineticBetAmount} USDC*\n` +
                        `🚀 Surfeando muro de liquidez...`
                    );
                }
            }
        } catch (e) {
            console.error(`❌ Error en Kinetic para ${market.title}:`, e.message);
        }
    }
}