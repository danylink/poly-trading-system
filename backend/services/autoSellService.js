// services/autoSellService.js - Auto Sell Manager (TP/SL)
import { botStatus, saveConfigToDisk } from '../config.js';
import { executeSellOnChain } from './polymarketService.js';
import { sendAlert } from './telegramService.js';
import { getRiskProfile, getCustomMarketRules } from '../utils/helpers.js';
import { updateRealBalances } from './balanceService.js';

const recentlySoldTokens = new Set();
const profitAlertCache = new Set(); // Para evitar spam de alertas

export async function autoSellManager() {
    if (!botStatus.autoTradeEnabled) return;

    const positionsToReview = [...botStatus.activePositions];

    for (const pos of positionsToReview) {
        if (pos.status && pos.status.includes('CANJEAR')) continue;

        const marketNameShort = (pos.marketName || "Mercado desconocido").substring(0, 60);

        // Actualizar precio actual si es necesario
        if (!pos.currentValue || typeof pos.currentValue !== 'number') {
            try {
                pos.currentValue = await getCurrentPositionValue?.(pos.tokenId) || pos.currentValue || 0;
            } catch (e) {
                console.warn(`[AUTOSELL] No se pudo actualizar precio de ${marketNameShort}`);
            }
        }

        const currentSharePrice = pos.exactSize > 0 
            ? (parseFloat(pos.currentValue) / parseFloat(pos.exactSize)) 
            : 0;
        
        const entryPrice = parseFloat(pos.priceEntry || 0);
        const profit = (entryPrice > 0 && currentSharePrice > 0) 
            ? ((currentSharePrice - entryPrice) / entryPrice) * 100 
            : 0;

        // ====================== DETERMINACIÓN DE ORIGEN ======================
        let originTag = 'IA';
        let isWhaleTrade = false;

        if (pos.engine && pos.engine !== null && pos.engine !== 'null') {
            originTag = pos.engine;                    // Trinity, EQUALIZER, CHRONOS, KINETIC, etc.
            isWhaleTrade = false;
        } 
        else if (pos.nickname || (pos.sizeCopied !== undefined && pos.sizeCopied > 0)) {
            isWhaleTrade = true;
            originTag = 'WHALE';
        } 
        else if (pos.engine === "EQUALIZER") originTag = 'EQUALIZER';
        else if (pos.engine === "CHRONOS") originTag = 'CHRONOS';
        else if (pos.engine === "KINETIC") originTag = 'KINETIC';

        const { config: riskConfig } = getRiskProfile(pos.marketName || "", isWhaleTrade);

        if (!botStatus.partialSells) botStatus.partialSells = [];
        const hasDonePartial = botStatus.partialSells.includes(pos.tokenId);

        if (Math.abs(profit) >= 8) {
            console.log(`[DEBUG AUTOSELL] ${originTag} | ${marketNameShort} | Profit: ${profit.toFixed(1)}% | Precio: $${currentSharePrice.toFixed(3)}`);
        }

        // ====================== TP PARCIAL (Solo Whales) ======================
        if (isWhaleTrade && profit >= 45 && profit < 80 && !hasDonePartial) {
            console.log(`[DEBUG PARCIAL] Intentando TP Parcial en ${marketNameShort}`);
            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { 
                    httpsAgent: agent, timeout: 10000 
                });
                const bids = bookResp.data?.bids || [];
                if (bids.length > 0) {
                    const bestPrice = parseFloat(bids[0].price);
                    const spread = currentSharePrice > 0 ? ((currentSharePrice - bestPrice) / currentSharePrice) * 100 : 0;
                    let maxSlip = currentSharePrice > 0.90 ? 98 : (botStatus.riskSettings.tpLiquiditySlippage || 55);

                    if (spread <= maxSlip && bestPrice > 0.001) {
                        const half = parseFloat(pos.exactSize || pos.size || 0) / 2;
                        const result = await executeSellOnChain(pos.conditionId || null, pos.tokenId, half, bestPrice, "0.01");
                        
                        if (result?.success) {
                            botStatus.partialSells.push(pos.tokenId);
                            console.log(`✅ TP PARCIAL EJECUTADO en ${marketNameShort}`);
                            saveConfigToDisk("TP Parcial");
                            await updateRealBalances();

                            const halfValue = (half * bestPrice).toFixed(2);
                            await sendAlert(
                                `🌓 TAKE PROFIT PARCIAL (50%)\n` +
                                `📈 Mercado: ${marketNameShort}\n` +
                                `💰 Mitad asegurada: +$${halfValue}\n` +
                                `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
                            );
                        }
                    } else {
                        console.log(`⚠️ [PARCIAL] Abortando ${marketNameShort} (spread ${spread.toFixed(1)}%)`);
                    }
                }
            } catch (e) {
                console.error(`❌ TP Parcial:`, e.message);
            }
        }

        // ====================== TP TOTAL ======================
        let effectiveTpThreshold = riskConfig.takeProfitThreshold || 15;

        const customRule = getCustomMarketRules(pos.marketName || "");
        if (customRule && customRule.takeProfitThreshold !== undefined) {
            effectiveTpThreshold = customRule.takeProfitThreshold;
        } else if (originTag === "EQUALIZER") effectiveTpThreshold = botStatus.equalizerTpThreshold ?? 15;
        else if (originTag === "CHRONOS") effectiveTpThreshold = botStatus.chronosTpThreshold ?? 20;
        else if (originTag === "KINETIC") effectiveTpThreshold = botStatus.kineticTpThreshold ?? 10;
        else if (isWhaleTrade && hasDonePartial) effectiveTpThreshold = botStatus.whalePostPartialTp ?? 80;

        const shouldTakeProfit = profit >= effectiveTpThreshold;
        const highPriceBypass = currentSharePrice >= 0.90 && profit >= 5.0;

        if (shouldTakeProfit || highPriceBypass) {
            console.log(`[TP TOTAL TRIGGER] ${marketNameShort} → Profit ${profit.toFixed(1)}% (Threshold: ${effectiveTpThreshold}%) | Engine: ${originTag}`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { 
                    httpsAgent: agent, timeout: 10000 
                });
                const bids = bookResp.data?.bids || [];
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                const bestPrice = parseFloat(bids[0].price || 0);
                const spreadDropPct = currentSharePrice > 0 ? ((currentSharePrice - bestPrice) / currentSharePrice) * 100 : 0;

                let maxAllowedSlippage = botStatus.riskSettings.tpLiquiditySlippage || 65;
                if (currentSharePrice >= 0.85 || profit >= 20) maxAllowedSlippage = 99.9;

                console.log(`[DEBUG TOTAL] Spread: ${spreadDropPct.toFixed(1)}% | Máx permitido: ${maxAllowedSlippage}% | Best Bid: $${bestPrice.toFixed(3)}`);

                if (spreadDropPct > maxAllowedSlippage && currentSharePrice < 0.98) {
                    console.log(`⚠️ [ALERTA LIQUIDEZ TP] Abortando ${marketNameShort} (spread ${spreadDropPct.toFixed(1)}%)`);
                    continue;
                }

                const result = await executeSellOnChain(pos.conditionId || null, pos.tokenId, sharesToSell, bestPrice || 0.01, "0.01");

                if (result?.success) {
                    console.log(`✅ TP TOTAL EJECUTADO [${originTag}] → ${marketNameShort} (+${profit.toFixed(1)}%)`);

                    closedPositionsCache.add(pos.tokenId);
                    delete botStatus.positionEngines[pos.tokenId];

                    if (originTag !== "EQUALIZER" && originTag !== "CHRONOS" && originTag !== "KINETIC" && !isWhaleTrade) {
                        const targetStats = botStatus.aiStats;
                        targetStats.wins = (targetStats.wins || 0) + 1;
                        targetStats.totalTrades = (targetStats.totalTrades || 0) + 1;
                        targetStats.winRate = (targetStats.wins / targetStats.totalTrades) * 100;
                    }

                    saveConfigToDisk(`TP ${originTag} Ejecutado`);
                    await updateRealBalances();

                    await sendAlert(
                        `✅ TAKE PROFIT TOTAL (${originTag})\n` +
                        `📈 Mercado: ${marketNameShort}\n` +
                        `💰 Ganancia: +${profit.toFixed(1)}%\n` +
                        `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
                    );
                }
            } catch (e) {
                console.error(`❌ Take Profit error:`, e.message);
            }
            continue;
        }

        // ====================== STOP LOSS ======================
        if (profit <= riskConfig.stopLossThreshold) {
            const isLotteryTicket = currentSharePrice <= 0.03;
            const isWorthRescuing = parseFloat(pos.currentValue || 0) >= 0.50;

            if (isLotteryTicket || !isWorthRescuing) {
                if (profit <= (riskConfig.stopLossThreshold - 10)) {
                    console.log(`🎫 [MOONSHOT] ${marketNameShort} → dejar a expiración`);
                }
                continue;
            }

            console.log(`🛑 STOP LOSS DETECTADO [${originTag}]: ${marketNameShort} (${profit.toFixed(1)}%)`);

            try {
                const bookResp = await axios.get(`https://clob.polymarket.com/book?token_id=${pos.tokenId}`, { 
                    httpsAgent: agent, timeout: 10000 
                });
                const bids = bookResp.data?.bids || [];
                if (bids.length === 0) continue;

                const sharesToSell = parseFloat(pos.exactSize || pos.size || 0);
                let bestBidPrice = parseFloat(bids[0].price);
                const spreadDropPct = currentSharePrice > 0 ? ((currentSharePrice - bestBidPrice) / currentSharePrice) * 100 : 0;

                let maxAllowedSlippage = botStatus.riskSettings.tpLiquiditySlippage || 55;

                if (currentSharePrice <= 0.10 || profit <= -70) maxAllowedSlippage = 99.0;
                else if (currentSharePrice <= 0.20 || profit <= -50) maxAllowedSlippage = 95;

                if (spreadDropPct > maxAllowedSlippage) {
                    console.log(`⚠️ [ALERTA LIQUIDEZ SL] Abortando ${marketNameShort} (spread ${spreadDropPct.toFixed(1)}%)`);
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

                const result = await executeSellOnChain(pos.conditionId || null, pos.tokenId, sharesToSell, worstPrice, "0.01");

                if (result?.success) {
                    console.log(`✅ SL EJECUTADO [${originTag}] → ${marketNameShort} (${profit.toFixed(1)}%)`);

                    closedPositionsCache.add(pos.tokenId);
                    delete botStatus.positionEngines[pos.tokenId];

                    if (originTag !== "EQUALIZER" && originTag !== "CHRONOS" && originTag !== "KINETIC") {
                        const targetStats = isWhaleTrade ? botStatus.whaleStats : botStatus.aiStats;
                        targetStats.losses = (targetStats.losses || 0) + 1;
                        targetStats.totalTrades = (targetStats.totalTrades || 0) + 1;
                        targetStats.winRate = (targetStats.wins || 0) / targetStats.totalTrades * 100;
                    }

                    saveConfigToDisk(`SL ${originTag} Ejecutado`);
                    await updateRealBalances();

                    await sendAlert(
                        `🛑 STOP LOSS EJECUTADO (${originTag})\n` +
                        `📉 Mercado: ${marketNameShort}\n` +
                        `💰 Pérdida: ${profit.toFixed(1)}%\n` +
                        `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
                    );
                }
            } catch (e) {
                console.error(`❌ Stop Loss error:`, e.message);
            }
        }
    }
}