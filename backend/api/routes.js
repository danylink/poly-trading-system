// api/routes.js
import express from 'express';
import { botStatus, saveConfigToDisk } from '../config.js';
import { memoryLogs } from '../utils/logger.js';
import { updateRealBalances } from '../services/balanceService.js';
import { initCLOB } from '../services/polymarketService.js';
import { sendAlert } from '../services/telegramService.js';
import { checkAndCopyWhaleTrades } from '../strategies/CopyTradingStrategy.js';
import { runWhaleRadar } from '../services/whaleService.js';

const router = express.Router();

// ====================== MIDDLEWARE DE AUTENTICACIÓN ======================
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'Sniper2026';

router.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    const providedPassword = req.headers['authorization'];
    if (providedPassword === DASHBOARD_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: 'Acceso Denegado: Bóveda cerrada' });
    }
});

// ====================== RUTAS BÁSICAS ======================

// Logs en vivo para el dashboard
router.get('/logs', (req, res) => res.json(memoryLogs));

// Estado completo del bot
router.get('/status', (req, res) => {
    res.json(botStatus);
});

// Redeem (gasless o directo)
router.get('/redeem', async (req, res) => {
    try {
        const useGasless = req.query.gasless === 'true' || botStatus.preferGaslessRedeem === true;

        let mensaje = `🔄 **RECLAMANDO USDC**\n`;
        mensaje += `Modo: ${useGasless ? '🟢 GASLESS (Relayer)' : '🔴 DIRECTO (paga gas)'}\n\n`;

        // 1. Cancelar órdenes abiertas
        console.log("🧹 Cancelando órdenes abiertas...");
        await clobClient.cancelAll().catch(() => {});
        mensaje += "✅ Órdenes abiertas canceladas.\n\n";

        // 2. Ejecutar Redeem según el modo elegido
        let redeemed = 0;
        if (useGasless) {
            redeemed = await autoRedeemPositionsGasless();
            mensaje += `✅ Gasless Redeem ejecutado (${redeemed} posiciones canjeadas).\n`;
        } else {
            redeemed = await autoRedeemPositions(); // versión directa
            mensaje += `✅ Redeem directo ejecutado (${redeemed} posiciones canjeadas).\n`;
        }

        // 3. Actualizar balances
        await updateRealBalances();

        const polyBalance = parseFloat(botStatus.clobOnlyUSDC || 0);
        const metaBalance = parseFloat(botStatus.walletOnlyUSDC || 0);
        const total = (polyBalance + metaBalance).toFixed(2);

        mensaje += `\n💰 **Saldo actual:** $${total} USDC\n`;
        mensaje += `   • Polymarket: $${polyBalance.toFixed(2)}\n`;
        mensaje += `   • MetaMask: $${metaBalance.toFixed(2)}`;

        console.log(`✅ Reclamo completado (${useGasless ? 'gasless' : 'directo'})`);
        res.send(mensaje);

    } catch (error) {
        console.error("❌ Error en /redeem:", error.message);
        res.send(`❌ Error durante el reclamo:\n${error.message}`);
    }
});

// ====================== SETTINGS ======================

// Riesgo bidimensional
router.post('/settings/risk', (req, res) => {
    const { source, profile, settings } = req.body;
    if (source === 'ai') botStatus.aiConfig[profile] = { ...botStatus.aiConfig[profile], ...settings };
    else if (source === 'whale') botStatus.whaleConfig[profile] = { ...botStatus.whaleConfig[profile], ...settings };
    saveConfigToDisk("API Riesgo");
    res.json({ success: true });
});

// Autotrade toggle
router.post('/settings/autotrade', (req, res) => {
    if (req.body.enabled !== undefined) botStatus.autoTradeEnabled = !!req.body.enabled;
    saveConfigToDisk("API Autotrade Toggle");
    res.json({ success: true, autoTradeEnabled: botStatus.autoTradeEnabled });
});

// Copy Trading toggles
router.post('/settings/copytrading', (req, res) => {
    const { customEnabled, autoEnabled, maxWhalesToCopy } = req.body;
    if (customEnabled !== undefined) botStatus.copyTradingCustomEnabled = !!customEnabled;
    if (autoEnabled !== undefined) botStatus.copyTradingAutoEnabled = !!autoEnabled;
    if (maxWhalesToCopy !== undefined) botStatus.maxWhalesToCopy = parseInt(maxWhalesToCopy) || 5;
    saveConfigToDisk("API CopyTrading Toggle");
    res.json({ success: true });
});

// Copy Filters (incluye maxCopyDaysForWhales)
router.post('/settings/copy-filters', (req, res) => {
    const { copyMinWhaleSize, copyTimeWindowMinutes, maxCopyMarketsPerWhale,
            autoWhaleCount, whalePostPartialTp, maxCopyMarketsCustom, maxCopyDaysForWhales } = req.body;

    if (copyMinWhaleSize !== undefined) botStatus.copyMinWhaleSize = parseInt(copyMinWhaleSize);
    if (copyTimeWindowMinutes !== undefined) botStatus.copyTimeWindowMinutes = parseInt(copyTimeWindowMinutes);
    if (maxCopyMarketsPerWhale !== undefined) botStatus.maxCopyMarketsPerWhale = parseInt(maxCopyMarketsPerWhale);
    if (autoWhaleCount !== undefined) botStatus.autoWhaleCount = parseInt(autoWhaleCount);
    if (whalePostPartialTp !== undefined) botStatus.whalePostPartialTp = parseFloat(whalePostPartialTp);
    if (maxCopyMarketsCustom !== undefined) botStatus.maxCopyMarketsCustom = parseInt(maxCopyMarketsCustom) || 10;
    if (maxCopyDaysForWhales !== undefined) botStatus.maxCopyDaysForWhales = parseInt(maxCopyDaysForWhales) || 15;

    saveConfigToDisk("Copy Filters Actualizados");
    res.json({ success: true, ...botStatus });
});

// Filtros de mercado
router.post('/settings/filters', (req, res) => {
    botStatus.marketFilters = { ...botStatus.marketFilters, ...req.body };
    saveConfigToDisk("Filtros de Mercado");
    res.json({ success: true, marketFilters: botStatus.marketFilters });
});

// Config general
router.post('/settings/config', (req, res) => {
    if (req.body.maxActiveSportsMarkets !== undefined) botStatus.maxActiveSportsMarkets = parseInt(req.body.maxActiveSportsMarkets);
    if (req.body.dailyLossLimit !== undefined) botStatus.dailyLossLimit = parseFloat(req.body.dailyLossLimit);
    saveConfigToDisk("API Config General");
    res.json({ success: true });
});

// Advanced Risk
router.post('/settings/advanced-risk', (req, res) => {
    botStatus.riskSettings = { ...botStatus.riskSettings, ...req.body };
    saveConfigToDisk("Advanced Risk");
    res.json({ success: true, riskSettings: botStatus.riskSettings });
});

// AI Reserve
router.post('/settings/ai-reserve', (req, res) => {
    if (req.body.amount !== undefined) botStatus.aiReserveAmount = parseFloat(req.body.amount);
    saveConfigToDisk("AI Reserve");
    res.json({ success: true, aiReserveAmount: botStatus.aiReserveAmount });
});

// ====================== TRADING MANUAL ======================

router.post('/execute-trade', async (req, res) => {
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
            // 6. COMPRA MANUAL
            await sendAlert(
                `💰 *COMPRA MANUAL FINALIZADA*\n\n` +
                `📋 Mercado: ${market}\n` +
                `💵 Precio: *$${finalPrice} USDC*\n` +
                `💰 Inversión: *$${amount} USDC*`
            );
            
            res.json({ success: true, message: "Operación exitosa", hash: result.hash });
        }
    } catch (e) {
        console.error("❌ Error en Ejecución Manual:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sell', async (req, res) => {
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
        // 7. VENTA MANUAL
        await sendAlert(
            `💰 *POSICIÓN VENDIDA (MANUAL)*\n\n` +
            `📋 Mercado: ${market || "Token " + tokenId.substring(0,8)}...\n` +
            `📊 Precio de Venta: *$${bestBidPrice}*\n` +
            `💸 Rescatado: *~$${gananciaEstimada} USDC*`
        );

        await updateRealBalances();
        res.json({ success: true, message: "Posición cerrada", data: sellOrder });

    } catch (error) {
        console.error("❌ Error en la venta:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ====================== PÁNICO ======================

router.post('/panic', (req, res) => {
    const { action } = req.body;
    botStatus.isPanicStopped = action === 'stop';
    if (action === 'resume') botStatus.dailyStartBalance = 0;
    saveConfigToDisk("Panic Toggle");
    res.json({ success: true, isPanicStopped: botStatus.isPanicStopped });
});

// ====================== CUSTOM WHALES ======================

router.get('/custom-whales', (req, res) => res.json(botStatus.customWhales || []));

router.post('/custom-whales', (req, res) => {
    try {
        const { address, nickname } = req.body;

        if (!address || typeof address !== 'string') {
            return res.status(400).json({ 
                success: false, 
                error: "Dirección es requerida" 
            });
        }

        const trimmedAddress = address.trim();

        if (!trimmedAddress.startsWith('0x') || trimmedAddress.length !== 42) {
            return res.status(400).json({ 
                success: false, 
                error: "Dirección inválida. Debe comenzar con 0x y tener exactamente 42 caracteres." 
            });
        }

        const normalizedAddress = trimmedAddress.toLowerCase();

        const exists = botStatus.customWhales.some(w => 
            w.address.toLowerCase() === normalizedAddress
        );

        if (exists) {
            return res.status(400).json({ 
                success: false, 
                error: "Esta ballena ya está agregada" 
            });
        }

        // Agregar la ballena
        botStatus.customWhales.push({ 
            address: normalizedAddress, 
            nickname: (nickname || "").trim(), 
            enabled: true 
        });

        saveConfigToDisk("Custom Whale Agregada");

        console.log(`✅ Ballena custom agregada correctamente: ${normalizedAddress}`);

        res.json({ 
            success: true, 
            message: "Ballena agregada correctamente",
            customWhales: botStatus.customWhales 
        });

    } catch (error) {
        console.error("❌ Error en /api/custom-whales:", error.message);
        res.status(500).json({ 
            success: false, 
            error: "Error interno del servidor al agregar la ballena" 
        });
    }
});

router.post('/custom-whales/toggle', (req, res) => {
    const { address, enabled } = req.body;
    const whale = botStatus.customWhales.find(w => w.address.toLowerCase() === address.toLowerCase());
    if (whale) {
        whale.enabled = !!enabled;
        saveConfigToDisk("Custom Whale Toggle");
        res.json({ success: true });
    } else res.status(404).json({ success: false });
});

router.delete('/custom-whales', (req, res) => {
    const { address } = req.body;
    botStatus.customWhales = botStatus.customWhales.filter(w => w.address.toLowerCase() !== address.toLowerCase());
    saveConfigToDisk("Custom Whale Eliminada");
    res.json({ success: true, customWhales: botStatus.customWhales });
});

// ====================== CUSTOM RULES ======================

router.get('/settings/custom-rules', (req, res) => res.json({ success: true, customMarketRules: botStatus.customMarketRules || [] }));

router.post('/settings/custom-rules', (req, res) => {
    try {
        const { rules } = req.body;
        if (!rules || !Array.isArray(rules)) return res.status(400).json({ success: false, error: "Se esperaba un array" });

        for (const rule of rules) {
            rule.keyword = (rule.keyword || "").trim();
            rule.takeProfitThreshold = parseInt(rule.takeProfitThreshold) || 25;
            rule.stopLossThreshold = parseInt(rule.stopLossThreshold) || -30;
            rule.microBetAmount = parseFloat(rule.microBetAmount) || 2.0;
            // 🔥 NUEVO: Guardar Edge y Probabilidad
            rule.edgeThreshold = parseFloat(rule.edgeThreshold) || undefined;
            rule.predictionThreshold = parseFloat(rule.predictionThreshold) || undefined;
        }

        botStatus.customMarketRules = rules;
        saveConfigToDisk("Reglas personalizadas actualizadas (edición)");
        console.log(`📋 ${rules.length} reglas personalizadas guardadas correctamente`);
        res.json({ success: true, customMarketRules: botStatus.customMarketRules });

    } catch (error) {
        console.error("❌ Error en /api/settings/custom-rules:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/settings/custom-rules', (req, res) => {
    try {
        const { keyword } = req.body;
        botStatus.customMarketRules = botStatus.customMarketRules.filter(r => 
            r.keyword.toLowerCase() !== keyword.toLowerCase()
        );
        saveConfigToDisk("Regla Eliminada");
        res.json({ success: true, customMarketRules: botStatus.customMarketRules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ====================== ENGINES ======================

router.post('/settings/equalizer', (req, res) => { 
    try {
        const { enabled, shockThreshold, betAmount, tpThreshold } = req.body;
        
        if (enabled !== undefined) botStatus.equalizerEnabled = Boolean(enabled);
        if (shockThreshold !== undefined) botStatus.equalizerShockThreshold = parseFloat(shockThreshold);
        if (betAmount !== undefined) botStatus.equalizerBetAmount = parseFloat(betAmount);
        if (tpThreshold !== undefined) botStatus.equalizerTpThreshold = parseFloat(tpThreshold);   // ← NUEVO

        saveConfigToDisk("Ajuste Quantum Equalizer");
        
        console.log(`🌊 [EQUALIZER] Ajustes: ON=${botStatus.equalizerEnabled} | Shock=${botStatus.equalizerShockThreshold}% | Bet=$${botStatus.equalizerBetAmount} | TP=${botStatus.equalizerTpThreshold}%`);
        
        res.json({ 
            success: true, 
            message: "Ecualizador actualizado",
            state: {
                enabled: botStatus.equalizerEnabled,
                shockThreshold: botStatus.equalizerShockThreshold,
                betAmount: botStatus.equalizerBetAmount,
                tpThreshold: botStatus.equalizerTpThreshold   // ← NUEVO
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/settings/chronos', (req, res) => { 
    try {
        const { enabled, betAmount, minPrice, maxPrice, hoursLeft, tpThreshold } = req.body;
        
        if (enabled !== undefined) botStatus.chronosEnabled = Boolean(enabled);
        if (betAmount !== undefined) botStatus.chronosBetAmount = parseFloat(betAmount);
        if (minPrice !== undefined) botStatus.chronosMinPrice = parseFloat(minPrice);
        if (maxPrice !== undefined) botStatus.chronosMaxPrice = parseFloat(maxPrice);
        if (hoursLeft !== undefined) botStatus.chronosHoursLeft = parseInt(hoursLeft);
        if (tpThreshold !== undefined) botStatus.chronosTpThreshold = parseFloat(tpThreshold);   // ← NUEVO
        
        saveConfigToDisk("Ajuste Chronos Harvester");
        
        console.log(`⏳ [CHRONOS] Ajustes: ON=${botStatus.chronosEnabled} | TP=${botStatus.chronosTpThreshold}% | ...`);
        
        res.json({ success: true, message: "Chronos actualizado" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/settings/kinetic', (req, res) => { 
    try {
        const { enabled, betAmount, imbalanceRatio, depthPercent, maxPositions, tpThreshold } = req.body;
        
        if (enabled !== undefined) botStatus.kineticEnabled = Boolean(enabled);
        if (betAmount !== undefined) botStatus.kineticBetAmount = parseFloat(betAmount);
        if (imbalanceRatio !== undefined) botStatus.kineticImbalanceRatio = parseFloat(imbalanceRatio);
        if (depthPercent !== undefined) botStatus.kineticDepthPercent = parseFloat(depthPercent);
        if (maxPositions !== undefined) botStatus.kineticMaxPositions = parseInt(maxPositions);
        if (tpThreshold !== undefined) botStatus.kineticTpThreshold = parseFloat(tpThreshold);   // ← NUEVO
        
        saveConfigToDisk("Ajuste Kinetic Pressure");
        
        console.log(`🌊 [KINETIC] Ajustes: ON=${botStatus.kineticEnabled} | TP=${botStatus.kineticTpThreshold}% | ...`);
        
        res.json({ success: true, message: "Kinetic actualizado" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ====================== RADAR ======================

router.get('/radar', (req, res) => res.json(
    res.json(whaleRadarCache);
));

router.post('/radar/force', async (req, res) => {
    await runWhaleRadar();
    res.json(whaleRadarCache);
});

export default router;