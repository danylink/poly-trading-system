// engines/SniperEngine.js
import { BaseEngine } from './BaseEngine.js';
import { botStatus } from '../config.js';
import { getMarketCategoryEnhanced, isMarketAllowed, getRiskProfile, getCustomMarketRules } from '../utils/helpers.js';
import { analyzeMarketWithClaude, analyzeMarketWithGemini, analyzeMarketWithGrok } from '../utils/ia.js'; // ← lo crearemos después
import { executeTradeOnChain } from '../services/polymarketService.js';
import { pendingOrdersCache, closedPositionsCache } from '../../utils/memory.js';
import { sendSniperAlert } from '../services/telegramService.js';
import { recordPriceToMemory } from '../utils/memory.js';

export class SniperEngine extends BaseEngine {
    constructor() {
        super("Sniper IA (Trinity)");
        this.watchlistIndex = 0;
    }

    async scan() {
        if (!botStatus.autoTradeEnabled || botStatus.isPanicStopped) return;
        // Aquí irá la lógica completa de runBot que tenías
        await this.runSniperCycle();
    }

    // ==========================================
    // 10. CICLO PRINCIPAL (EL CEREBRO DEL BOT)
    // ==========================================
    let watchlistIndex = 0;

    async runSniperCycle() {
        
    if (botStatus.isPanicStopped) {
        console.log("🚨 [MODO PÁNICO] Compras bloqueadas. Ejecutando únicamente motor de ventas (TP/SL)...");
        try { await autoSellManager(); } catch (e) { console.log("Error autoSell:", e); }
        return; 
    }

    // 🛡️ PREVENTIVO: Si no hay mercados para la IA, abortamos el ciclo temprano
    if (!botStatus.watchlist || botStatus.watchlist.length === 0) {
        return;
    }

    botStatus.lastCheck = new Date().toLocaleTimeString();

    try {
        await fetchRealTrades();
        await updateRealBalances();
        await cleanupCopiedState();

        // 2. Copy-Trading (Auto + Custom)
        if (botStatus.copyTradingCustomEnabled || 
            botStatus.copyTradingAutoEnabled || 
            (botStatus.copiedPositions && botStatus.copiedPositions.length > 0)) {
            
            if (botStatus.copyTradingAutoEnabled) {
                if (!botStatus.lastWhaleSelection || 
                    (Date.now() - new Date(botStatus.lastWhaleSelection).getTime()) > 15 * 60 * 1000) {
                    await autoSelectTopWhales();
                }
            }
            await checkAndCopyWhaleTrades();
        }

        await checkDailyLossLimit();

        if (botStatus.autoTradeEnabled) {
            await autoSellManager();
        }

        // 3. Rotación Segura de Watchlist (Micro-Watchlist IA)
        if (watchlistIndex >= botStatus.watchlist.length) watchlistIndex = 0;

        const marketItem = botStatus.watchlist[watchlistIndex];
        if (!marketItem || !marketItem.tokenId) {
            watchlistIndex++;
            return;
        }

        const marketTitle = marketItem.title;
        botStatus.currentMarket = marketItem;
        botStatus.currentTopic = marketTitle;

        // === OPTIMIZACIÓN QUANT: PRE-FILTRO DE PRECIO ===
        // Si ambos lados del mercado están fuera de nuestro rango operable (muy caros o muy baratos),
        // saltamos al siguiente mercado SIN gastar créditos de IA.
        const prePriceYes = marketItem.priceYes || 0;
        const prePriceNo = marketItem.priceNo || 0;
        
        if ((prePriceYes < 0.05 || prePriceYes > 0.85) && (prePriceNo < 0.05 || prePriceNo > 0.85)) {
            watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
            return;
        }

        // ====================================================
        // 🧠 EJECUCIÓN MULTI-AGENTE (CLAUDE + GEMINI + GROK)
        // ====================================================
        const newsString = await getLatestNews(marketTitle, marketItem.category);
        
        // 🔥 FIX QUANT: Caché basado en el ID del mercado y la hora (No en el texto de las noticias)
        // Esto evita que micro-noticias rompan el caché y quemen cuota de API.
        // Redondeamos Date.now() a bloques de 45 minutos.
        const timeBlock = Math.floor(Date.now() / (45 * 60 * 1000));
        const cacheKey = `${marketItem.conditionId}-${timeBlock}`;

        let finalAnalysis;
        let useCache = false;

        if (analysisCache.has(cacheKey)) {
            const cached = analysisCache.get(cacheKey);
            finalAnalysis = cached;
            useCache = true;
            console.log(`♻️ Usando caché multi-agente para ${marketTitle.substring(0,30)}`);
        }

        if (!useCache) {
            console.log(`\n🤖 Analizando con la Trinidad: ${marketTitle.substring(0,45)}...`);

            // Disparamos las 3 APIs al mismo tiempo por velocidad
            const [claudeResult, geminiResult, grokResult] = await Promise.all([
                analyzeMarketWithClaude(marketTitle, newsString),
                analyzeMarketWithGemini(marketTitle, newsString),
                analyzeMarketWithGrok(marketTitle, newsString)
            ]);

            // 🛡️ FIX QUANT: Purga de errores y Matriz de Supervivencia
            const validResults = [];
            if (!claudeResult.isError) validResults.push({ ...claudeResult, engine: "Claude", buy: claudeResult.recommendation.includes("BUY") });
            if (!geminiResult.isError) validResults.push({ ...geminiResult, engine: "Gemini", buy: geminiResult.recommendation.includes("BUY") });
            if (!grokResult.isError) validResults.push({ ...grokResult, engine: "Grok", buy: grokResult.recommendation.includes("BUY") });

            // 🚨 KILL SWITCH: Si las 3 APIs están caídas, abortamos para proteger el saldo
            if (validResults.length === 0) {
                console.log("🚫 [SNIPER ABORTADO] Las 3 IAs fallaron (Rate Limits). Protegiendo capital, no disparamos a ciegas.");
                watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                return;
            }

            // === FUSIÓN DE OPINIONES Y FALLBACK DINÁMICO ===
            const buyVotes = validResults.filter(r => r.buy).length;
            finalAnalysis = { prob: 0, edge: 0, recommendation: "WAIT", reason: "", urgency: 5, engine: "None" };

            // CASO A: Sobrevivieron al menos 2 modelos y están de acuerdo en COMPRAR (Consenso Dinámico)
            if (validResults.length >= 2 && buyVotes >= 2) {
                console.log(`🔥 ¡CONSENSO DINÁMICO FUERTE! (${buyVotes}/${validResults.length} votos válidos)`);
                
                const activeBuys = validResults.filter(r => r.buy);
                
                finalAnalysis.prob = activeBuys.reduce((sum, r) => sum + r.prob, 0) / buyVotes;
                finalAnalysis.edge = activeBuys.reduce((sum, r) => sum + r.edge, 0) / buyVotes;
                finalAnalysis.urgency = Math.max(...activeBuys.map(r => r.urgency));
                finalAnalysis.recommendation = "STRONG_BUY"; 
                finalAnalysis.reason = `[CONSENSO] ` + activeBuys.map(r => `${r.engine.charAt(0)}: ${r.reason}`).join(" | ");
                finalAnalysis.engine = buyVotes === 3 ? "Trinity (C+G+X)" : `Consenso (${activeBuys.map(r => r.engine.charAt(0)).join('+')})`;

            } else {
                // CASO B: CASCADA DE FALLBACK ESTRICTA (Si no hay consenso o cayeron modelos clave)
                const claudeValid = validResults.find(r => r.engine === "Claude");
                const geminiValid = validResults.find(r => r.engine === "Gemini");
                const grokValid = validResults.find(r => r.engine === "Grok");

                if (claudeValid) {
                    finalAnalysis = { ...claudeValid };
                } else if (geminiValid) {
                    console.log("⚠️ [FALLBACK] Claude saturado. Gemini asume el control del disparo.");
                    finalAnalysis = { ...geminiValid };
                } else if (grokValid) {
                    console.log("⚠️ [FALLBACK] Claude y Gemini saturados. Grok asume el control del disparo.");
                    finalAnalysis = { ...grokValid };
                }
            }

            // Almacenamos en caché el resultado sanitizado
            analysisCache.set(cacheKey, { ...finalAnalysis });
            if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
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

        if (edgeNo > edgeYes && edgeNo > 0.04) {
            bestEdge = edgeNo;
            targetTokenId = marketItem.tokenNo;
            targetPrice = priceNo;
            targetProb = probNo;
            targetSideLabel = "NO";
        }

        const livePrice = targetPrice;
        const edge = bestEdge;

        // ====================== FILTROS DE SEGURIDAD ======================
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

        // OBTENEMOS PERFIL CON REGLAS CUSTOM INCLUIDAS
        const { config: profile, profileType, usedCustomRule } = getRiskProfile(marketTitle, false);

        const activeSportsCount = botStatus.activePositions.filter(p => p.category === 'SPORTS').length;
        const isSportsLimitReached = (marketItem.category === 'SPORTS' && 
                                     botStatus.maxActiveSportsMarkets > 0 && 
                                     activeSportsCount >= botStatus.maxActiveSportsMarkets);

        const isFlippedToNo = (targetSideLabel === "NO");

        // FALLBACK MATEMÁTICO
        const minEdge = profile.edgeThreshold !== undefined ? profile.edgeThreshold : botStatus.aiConfig.standard.edgeThreshold;
        const minProb = profile.predictionThreshold !== undefined ? profile.predictionThreshold : botStatus.aiConfig.standard.predictionThreshold;

        // ====================== SEÑAL FUERTE ======================
        const isStrongSignal = 
            (!alreadyInvested && !alreadyClosed && !alreadyPending && !isSportsLimitReached) && (
                
                // CASO 1: Consenso Fuerte (Trinity o Dinámico)
                (finalAnalysis.engine && (finalAnalysis.engine.includes("Trinity") || finalAnalysis.engine.includes("Consenso")) && 
                 targetProb >= minProb - 0.05 && edge >= Math.max(0.04, minEdge - 0.015)) ||
                
                // CASO 2: Recomendación MUY FUERTE (STRONG_BUY).
                (finalAnalysis.recommendation === "STRONG_BUY" && 
                 targetProb >= minProb - 0.02 && edge >= minEdge + 0.015) ||
                
                // CASO 3: Recomendación NORMAL (BUY o Flipped).
                ((finalAnalysis.recommendation === "BUY" || isFlippedToNo) && 
                 targetProb >= minProb + 0.03 && edge >= minEdge + 0.005) ||
                
                // CASO 4: Urgencia Extrema (Noticias).
                (finalAnalysis.urgency >= 9 && 
                 targetProb >= minProb && edge >= minEdge - 0.01) ||

                // CASO 5: Oportunidad de Oro (Asimetría Extrema)
                (edge >= 0.20 && targetProb >= 0.60 && finalAnalysis.engine && (finalAnalysis.engine.includes("Consenso") || finalAnalysis.engine.includes("Trinity")))
            );

        if (isSportsLimitReached) {
            console.log(`⚠️ [LIMITE] Omitiendo ${marketTitle} (límite de deportes alcanzado)`);
        }

        // ====================== EJECUCIÓN DEL SNIPER ======================
        if (botStatus.autoTradeEnabled && isStrongSignal) {

            const saldoLibre = (parseFloat(botStatus.clobOnlyUSDC) || 0).toFixed(2);
            let dynamicBetAmount = profile.microBetAmount || 2.0;

            // Kelly Asimétrico
            if (edge > 0.25 && livePrice > 0 && livePrice < 1) {
                const kellyFraction = edge / (1 - livePrice);
                dynamicBetAmount = Math.min(
                    saldoLibre * kellyFraction * 0.20,   
                    saldoLibre * 0.05,                   
                    profile.microBetAmount * 5.0         
                );
            }

            dynamicBetAmount = Math.max(dynamicBetAmount, 0.5);
            dynamicBetAmount = Math.min(dynamicBetAmount, saldoLibre * 0.15);

            const lastTradeTime = botStatus.lastTrades[targetTokenId];
            if (lastTradeTime) {
                const minutesSince = (Date.now() - lastTradeTime) / 60000;
                if (minutesSince < botStatus.riskSettings.tradeCooldownMin) {
                    console.log(`⏳ COOLDOWN: Esperando ${Math.ceil(botStatus.riskSettings.tradeCooldownMin - minutesSince)}m`);
                    watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;
                    return; 
                }
            }

            console.log(`🎯 SNIPER DISPARO [${finalAnalysis.engine}] → [${targetSideLabel}] | Edge: ${(edge*100).toFixed(1)}% | Apuesta: $${dynamicBetAmount.toFixed(2)} ${usedCustomRule ? '(regla personalizada)' : '(global)'}`);

            const result = await executeTradeOnChain(
                marketItem.conditionId, 
                targetTokenId, 
                dynamicBetAmount, 
                livePrice, 
                marketItem.tickSize || "0.01"
            );

            if (result?.success) {
                pendingOrdersCache.add(targetTokenId);
                setTimeout(() => pendingOrdersCache.delete(targetTokenId), 60000); 
                
                botStatus.positionEngines[targetTokenId] = finalAnalysis.engine || "IA";
                saveConfigToDisk("Disparo Sniper IA");
                
                await sendSniperAlert({
                    marketName: `${marketTitle} (Apuesta al ${targetSideLabel})`, 
                    probability: targetProb, 
                    marketPrice: livePrice,
                    edge: edge,
                    suggestedInversion: dynamicBetAmount, 
                    reasoning: finalAnalysis.reason,
                    engine: finalAnalysis.engine || "IA"
                });

                botStatus.lastTrades[targetTokenId] = Date.now();
            }
        }

        // ====================== ACTUALIZAR DASHBOARD ======================
        const signalIndex = botStatus.pendingSignals.findIndex(s => s.tokenId === targetTokenId);

        const signalData = {
            id: Date.now(),
            marketName: marketTitle,
            tokenId: targetTokenId,
            conditionId: marketItem.conditionId,
            probability: targetProb || 0,
            reasoning: finalAnalysis.reason || "Evaluado por IA",
            marketPrice: livePrice,
            suggestedInversion: profile.microBetAmount || 2.0, 
            edge: edge,
            urgency: finalAnalysis.urgency || 5,
            recommendation: finalAnalysis.recommendation || "WAIT",
            category: marketItem.category,
            side: targetSideLabel,
            profile: profileType,
            engine: finalAnalysis.engine
        };

        if (signalIndex === -1) {
            botStatus.pendingSignals.unshift(signalData);
            if (botStatus.pendingSignals.length > 12) botStatus.pendingSignals.pop();
        } else {
            botStatus.pendingSignals[signalIndex] = { ...botStatus.pendingSignals[signalIndex], ...signalData };
        }

        watchlistIndex = (watchlistIndex + 1) % botStatus.watchlist.length;

    } catch (error) {
        console.error('❌ Error en runBot:', error.message);
    }
    }
}