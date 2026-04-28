// strategies/CopyTradingStrategy.js
import { botStatus } from '../config.js';
import { executeTradeOnChain, executeSellOnChain } from '../services/polymarketService.js';
import { sendCopyAlert } from '../services/telegramService.js';
import { getRiskProfile, isMarketAllowed, getMarketCategoryEnhanced } from '../utils/helpers.js';

let isScanningWhales = false;

export async function checkAndCopyWhaleTrades() {
    if (isScanningWhales) return;

    isScanningWhales = true;

    try {
        // ==================== LIMPIEZA DE FANTASMAS ====================
        if (botStatus.copiedPositions && botStatus.activePositions) {
            const activeTokens = new Set(botStatus.activePositions.map(p => p.tokenId));
            const originalCount = botStatus.copiedPositions.length;

            botStatus.copiedPositions = botStatus.copiedPositions.filter(cp => activeTokens.has(cp.tokenId));

            if (originalCount !== botStatus.copiedPositions.length) {
                console.log(`🧹 [SYNC] Memoria purgada. Se borraron ${originalCount - botStatus.copiedPositions.length} trades huérfanos.`);
            }
        }

        const currentActiveCopied = (botStatus.copiedPositions || []).length;

        // Cheque global
        if ((botStatus.copyTradingCustomEnabled || botStatus.copyTradingAutoEnabled) &&
            currentActiveCopied >= (botStatus.maxCopyMarketsCustom || 10)) {
            console.log(`⛔ [COPY LIMIT GLOBAL] Límite alcanzado (${currentActiveCopied}/${botStatus.maxCopyMarketsCustom})`);
            return;
        }

        if (!botStatus.copyTradingCustomEnabled && 
            !botStatus.copyTradingAutoEnabled && 
            currentActiveCopied === 0) return;

        let allWhales = [];

        // Auto Whales
        if (botStatus.copyTradingAutoEnabled) {
            // ... tu lógica de autoSelectTopWhales si es necesario ...
        }

        // Custom Whales
        const enabledCustom = (botStatus.customWhales || []).filter(w => w.enabled === true);
        allWhales = allWhales.concat(enabledCustom);

        // Eliminar duplicados
        const seen = new Set();
        allWhales = allWhales.filter(whale => {
            const addr = whale.address.toLowerCase();
            if (seen.has(addr)) return false;
            seen.add(addr);
            return true;
        });

        const getWhaleDisplayName = (whale) => {
            return whale.nickname || whale.address.substring(0, 8) + "...";
        };

        // Procesamiento por ballena
        for (const whale of allWhales) {
            try {
                let copiedFromThisWhale = botStatus.copiedPositions.filter(p => 
                    p.whale && p.whale.toLowerCase() === whale.address.toLowerCase()
                ).length;

                const limitPerWhale = botStatus.maxCopyMarketsPerWhale || 1;

                if (limitPerWhale > 0 && copiedFromThisWhale >= limitPerWhale) {
                    console.log(`⛔ [COPY LIMIT PER WHALE] ${getWhaleDisplayName(whale)} ya tiene ${copiedFromThisWhale} mercados.`);
                    continue;
                }

                const response = await axios.get(
                    `https://data-api.polymarket.com/trades?user=${whale.address}&limit=12`,
                    { httpsAgent: agent, timeout: 8000 }
                );

                const recentTrades = Array.isArray(response.data) 
                    ? response.data 
                    : (response.data.data || response.data.trades || []);

                // Actualizar última actividad
                if (recentTrades.length > 0) {
                    const idx = botStatus.customWhales.findIndex(w => w.address.toLowerCase() === whale.address.toLowerCase());
                    if (idx !== -1) botStatus.customWhales[idx].lastActive = Date.now();
                }

                const uniqueMarketsThisScan = new Set();

                for (const trade of recentTrades) {
                    if (!trade) continue;

                    const side = (trade.side || "").toUpperCase();
                    const tokenId = trade.asset || trade.token_id || trade.asset_id;
                    if (!tokenId || uniqueMarketsThisScan.has(tokenId)) continue;

                    const whaleUsdValue = parseFloat(trade.size || 0) * parseFloat(trade.price || 0);
                    if (whaleUsdValue < botStatus.copyMinWhaleSize) continue;

                    let tradeDate = trade.timestamp 
                        ? (typeof trade.timestamp === 'string' && trade.timestamp.includes('T') 
                            ? new Date(trade.timestamp).getTime() 
                            : parseInt(trade.timestamp) * 1000) 
                        : Date.now();

                    if (Date.now() - tradeDate > botStatus.copyTimeWindowMinutes * 60 * 1000) continue;

                    let title = trade.title || trade.market_title || trade.asset_name || "Mercado desconocido";
                    let finalConditionId = trade.condition_id || trade.conditionId;

                     // Ejemplo de BUY:
                    if (side === "BUY") {
                        // Cheque global otra vez (por si se llenó durante este ciclo)
                        if ((botStatus.copiedPositions || []).length >= (botStatus.maxCopyMarketsCustom || 10)) {
                            console.log(`⛔ [COPY LIMIT GLOBAL] Límite total alcanzado durante el scan. Abortando.`);
                            break;
                        }

                        if (limitPerWhale > 0 && copiedFromThisWhale >= limitPerWhale) {
                            console.log(`⛔ [COPY LIMIT PER WHALE] Freno dinámico para ${getWhaleDisplayName(whale)}`);
                            break;
                        }

                        // ====================== TU LÓGICA ORIGINAL DE COMPRA ======================
                        const isAutoWhale = (botStatus.autoSelectedWhales || []).some(w => w.address.toLowerCase() === whale.address.toLowerCase());
                        const isCustomWhale = (botStatus.customWhales || []).some(w => w.address.toLowerCase() === whale.address.toLowerCase());
                        
                        if (isAutoWhale && !botStatus.copyTradingAutoEnabled) continue;
                        if (isCustomWhale && !botStatus.copyTradingCustomEnabled) continue;

                        if (!isMarketAllowed(title)) continue;

                        const marketCat = getMarketCategoryEnhanced(title);
                        if (marketCat === 'SPORTS' && botStatus.maxActiveSportsMarkets > 0) {
                            const activeSportsCount = botStatus.activePositions.filter(p => p.category === 'SPORTS').length;
                            if (activeSportsCount >= botStatus.maxActiveSportsMarkets) continue;
                        }

                        const alreadyHavePosition = botStatus.activePositions.some(p => p.tokenId === tokenId);
                        const alreadyCopied = botStatus.copiedTrades.some(t => t.txHash === (trade.transaction_hash || trade.id));
                        const alreadyPending = pendingOrdersCache.has(tokenId);

                        if (alreadyHavePosition || alreadyCopied || alreadyPending) continue;

                        const { config: riskConfig } = getRiskProfile(title, true);
                        const currentBalance = parseFloat(botStatus.clobOnlyUSDC || 0);

                        const maxPct = riskConfig.maxCopyPercentOfBalance || 8;
                        const maxAllowedPercent = currentBalance * (maxPct / 100);
                        let montoInversion = Math.min(riskConfig.maxCopySize || 50, maxAllowedPercent);
                        if (montoInversion < 1) montoInversion = 1;

                        const RESERVE_FOR_AI = botStatus.aiReserveAmount !== undefined ? botStatus.aiReserveAmount : 50;
                        if (currentBalance - montoInversion < RESERVE_FOR_AI) {
                            console.log(`🛡️ [RESERVA IA] Saldo libre ($${currentBalance.toFixed(2)}) muy cerca de reserva ($${RESERVE_FOR_AI}). Copy bloqueado.`);
                            continue;
                        }

                        if (currentBalance < montoInversion) continue;

                        let limitPrice = parseFloat(trade.price || 0) * 1.04;
                        if (limitPrice > 0.99) limitPrice = 0.99;

                        const lastTradeTime = botStatus.lastTrades[tokenId];
                        if (lastTradeTime && (Date.now() - lastTradeTime) < botStatus.riskSettings.tradeCooldownMin * 60000) continue;

                        pendingOrdersCache.add(tokenId);

                        console.log(`🔥 [COPY BUY] ${getWhaleDisplayName(whale)} → ${title.substring(0, 45)}... (Inversión Whale: $${whaleUsdValue.toFixed(0)})`);

                        // ====================== EJECUCIÓN REAL ======================
                        const result = await executeTradeOnChain(finalConditionId, tokenId, montoInversion, limitPrice, "0.01");

                        if (result?.success) {
                            setTimeout(() => pendingOrdersCache.delete(tokenId), 60000);

                            botStatus.positionEngines[tokenId] = whale.nickname || getWhaleDisplayName(whale);
                            copiedFromThisWhale++;
                            uniqueMarketsThisScan.add(tokenId);

                            botStatus.copiedTrades.unshift({
                                id: Date.now(),
                                txHash: trade.transaction_hash || trade.id || '',
                                whale: whale.address,
                                nickname: whale.nickname || getWhaleDisplayName(whale),
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
                                nickname: whale.nickname || getWhaleDisplayName(whale),
                                sizeCopied: montoInversion,
                                priceEntry: limitPrice,
                                marketName: title
                            });

                            saveConfigToDisk("Nueva Ballena Copiada");
                            botStatus.copyTradingStats.totalCopied = (botStatus.copyTradingStats.totalCopied || 0) + 1;
                            botStatus.copyTradingStats.successful = (botStatus.copyTradingStats.successful || 0) + 1;

                            await sendCopyAlert('BUY', getWhaleDisplayName(whale), title, montoInversion.toFixed(2));
                            botStatus.lastTrades[tokenId] = Date.now();
                        } else {
                            pendingOrdersCache.delete(tokenId);
                        }
                    }
                    else if (side === "SELL") {
                        // Tu lógica de SELL original (sin cambios)
                        const copiedIndex = botStatus.copiedPositions.findIndex(p => p.tokenId === tokenId && p.whale === whale.address);
                        if (copiedIndex === -1) continue;

                        const position = botStatus.copiedPositions[copiedIndex];
                        const activePos = botStatus.activePositions.find(p => p.tokenId === tokenId);
                        if (!activePos) continue;

                        const sharesToSell = parseFloat(activePos.exactSize || activePos.size);
                        const slippagePct = botStatus.riskSettings?.entrySlippage || 5;
                        let limitSellPrice = parseFloat(trade.price || 0) * (1 - (slippagePct / 100));
                        if (limitSellPrice < 0.01) limitSellPrice = 0.01;

                        const sellResult = await executeSellOnChain(finalConditionId, tokenId, sharesToSell, limitSellPrice, "0.01");

                        if (sellResult?.success) {
                            botStatus.copiedPositions.splice(copiedIndex, 1);
                            saveConfigToDisk("Ballena Vendida");
                            const rescateEst = (sharesToSell * limitSellPrice).toFixed(2);
                            await sendCopyAlert('SELL', position.nickname || getWhaleDisplayName(whale), title, rescateEst);
                        }
                    } 

            } catch (err) {
                if (!err.message.includes('429') && !err.message.includes('timeout')) {
                    console.error(`❌ Error con whale ${getWhaleDisplayName(whale)}:`, err.message);
                }
            }
        }

    } finally {
        isScanningWhales = false;
    }
}