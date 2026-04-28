// utils/helpers.js
import { botStatus } from '../config.js';

export function getMarketCategoryEnhanced(title = "") {
    const lower = title.toLowerCase();

    if (lower.includes("5m") || lower.includes("15m") || lower.includes("up or down") || 
        lower.includes("up/down") || lower.includes("weather") || lower.includes("temperature")) {
        return "SHORT_TERM";
    }

    if (lower.includes("bitcoin") || lower.includes("btc") || lower.includes("eth") || lower.includes("crypto")) return 'CRYPTO';
    if (lower.includes("trump") || lower.includes("biden") || lower.includes("election") || 
        lower.includes("putin") || lower.includes("ukraine") || lower.includes("iran")) return 'GEOPOLITICS';
    if (lower.includes("nba") || lower.includes("nfl") || lower.includes("soccer") || 
        lower.includes("f1") || lower.includes("ufc")) return 'SPORTS';

    return null;
}

export function isMarketAllowed(title = "", slug = "") {
    const text = `${title} ${slug}`.toLowerCase();

    const isSports = /\b(nba|nfl|mlb|nhl|soccer|tennis|f1|ufc|wwe|mma|league|champions|madrid|lakers|yankees)\b/i.test(text) || 
                     text.includes(" vs ");

    const isCrypto = /bitcoin|btc|eth|sol|crypto|airdrop|token/i.test(text);
    const isPolitics = /trump|biden|election|president|senate|putin|ukraine|iran/i.test(text);
    const isPop = /movie|oscar|grammy|mrbeast|youtube|tiktok/i.test(text);

    if (isSports && !botStatus.marketFilters.sports) return false;
    if (isCrypto && !botStatus.marketFilters.crypto) return false;
    if (isPolitics && !botStatus.marketFilters.politics) return false;
    if (isPop && !botStatus.marketFilters.pop) return false;

    return true;
}

export function getRiskProfile(marketName = "", isWhale = false) {
    const text = (marketName || "").toLowerCase();
    const isVolatile = /nba|nfl|mlb|soccer|tennis|f1|ufc|temperature/i.test(text);
    const profileType = isVolatile ? 'volatile' : 'standard';

    let config = isWhale 
        ? { ...botStatus.whaleConfig[profileType] } 
        : { ...botStatus.aiConfig[profileType] };

    const customRule = getCustomMarketRules(marketName);
    if (customRule) {
        Object.assign(config, customRule);
    }

    return { config, profileType, usedCustomRule: !!customRule };
}

export function getCustomMarketRules(marketTitle = "") {
    if (!botStatus.customMarketRules?.length) return null;

    const titleLower = marketTitle.toLowerCase();

    for (const rule of botStatus.customMarketRules) {
        if (titleLower.includes(rule.keyword.toLowerCase())) {
            console.log(`📋 [CUSTOM RULE] Aplicada → ${marketTitle}`);
            return rule;
        }
    }
    return null;
}

// ==========================================
// NOTICIAS
// ==========================================
export async function getLatestNews(query, category) {
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
// LIMPIEZA Y MONITOREO
// ==========================================
export async function cleanupCopiedState() {
    if (!botStatus.copiedTrades || !botStatus.copiedPositions) return;

    if (botStatus.copiedTrades.length > 25) {
        botStatus.copiedTrades = botStatus.copiedTrades.slice(0, 25);
    }
    // saveConfigToDisk se llama desde donde sea necesario
}

export async function monitorPortfolio() {
    try {
        console.log("🕵️‍♂️ Revisando PnL del portafolio...");
        
        // Primero nos aseguramos de tener los saldos más frescos
        await updateRealBalances();
        // Quitar trades huérfanos (que ya no están activos)
        await cleanupCopiedState();

        if (!botStatus.activePositions || botStatus.activePositions.length === 0) {
            profitAlertCache.clear(); // Si no hay posiciones, limpiamos la memoria
            return;
        }

        let posicionesGanadoras = [];
        let totalPnl = 0;
        
        // Mapeamos los IDs de las posiciones actuales para limpiar el caché de las que ya se vendieron
        const currentTokenIds = botStatus.activePositions.map(p => p.tokenId);
        for (const id of profitAlertCache) {
            if (!currentTokenIds.includes(id)) profitAlertCache.delete(id);
        }

        for (const pos of botStatus.activePositions) {
            // Solo evaluamos los que están vivos
            if (pos.status.includes('ACTIVO')) {
                totalPnl += (pos.cashPnl || 0);
                
                // 🔥 LA REGLA DE ORO: Si la ganancia supera el 5% y NO hemos avisado antes
                if (pos.percentPnl && pos.percentPnl >= 5.0) {
                    
                    if (!profitAlertCache.has(pos.tokenId)) {
                        posicionesGanadoras.push(
                            `📈 *${pos.marketName.substring(0,35)}...*\n` +
                            `Valor Actual: *$${pos.currentValue} USDC*\n` +
                            `Ganancia: *+$${pos.cashPnl.toFixed(2)} (+${pos.percentPnl.toFixed(1)}%)*\n` +
                            `⏳ _Esperando llegar al Auto-Sell (15%)_`
                        );
                        // Lo guardamos en memoria para no volver a hacer spam
                        profitAlertCache.add(pos.tokenId);
                    }
                }
            }
        }

        // Si encontró NUEVAS posiciones jugosas, dispara el mensaje a Telegram
        // if (posicionesGanadoras.length > 0) {
        //     const alerta = `🚨 *ALERTA DE TOMA DE GANANCIAS* 🚨\nNuevas posiciones cruzaron el 5% de ganancia:\n\n${posicionesGanadoras.join('\n\n')}\n\n💵 *PnL Global Flotante: $${totalPnl.toFixed(2)}*`;
        //     await sendAlert(alerta);
        // }

    } catch (error) {
        console.error("❌ Error en monitorPortfolio:", error.message);
    }
}

export async function checkDailyLossLimit() {
    if (!botStatus.copyTradingCustomEnabled && 
        !botStatus.copyTradingAutoEnabled && 
        !botStatus.autoTradeEnabled) return;

    try {
        let activePortfolioValue = 0;
        if (botStatus.activePositions && botStatus.activePositions.length > 0) {
            activePortfolioValue = botStatus.activePositions.reduce((acc, pos) => {
                return !pos.status.includes('CANJEAR') ? acc + parseFloat(pos.currentValue || 0) : acc;
            }, 0);
        }

        // 🔥 FIX CRÍTICO: Sumar TODA la liquidez (incluyendo MetaMask y premios sin reclamar)
        const polyUSDC = parseFloat(botStatus.clobOnlyUSDC || 0);
        const walletUSDC = parseFloat(botStatus.walletOnlyUSDC || 0);
        const unclaimedUSDC = parseFloat(botStatus.unclaimedUSDC || 0);

        const totalCurrentValue = polyUSDC + walletUSDC + unclaimedUSDC + activePortfolioValue;

        if (botStatus.dailyStartBalance === 0) {
            botStatus.dailyStartBalance = totalCurrentValue;
        }

        const dailyPnL = totalCurrentValue - botStatus.dailyStartBalance;
        botStatus.dailyPnL = dailyPnL;

        const lossPercent = botStatus.dailyStartBalance > 0 
            ? (dailyPnL / botStatus.dailyStartBalance) * 100 
            : 0;

        if (lossPercent <= -botStatus.dailyLossLimit && !botStatus.isPanicStopped) {
            console.log(`🚨 [DAILY LIMIT] Stop-loss diario activado (${lossPercent.toFixed(1)}%). Deteniendo bot...`);
            botStatus.isPanicStopped = true;
            // 4. STOP-LOSS DIARIO
            await sendAlert(
                `🚨 *STOP-LOSS DIARIO ACTIVADO*\n\n` +
                `📉 Pérdida del día: *${lossPercent.toFixed(1)}%*\n` +
                `Bot bloqueó nuevas compras automáticamente.\n` +
                `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
            );
        }
    } catch (e) {
        console.error("Error en checkDailyLossLimit:", e.message);
    }
}

export function runGarbageCollector() {
    console.log("🧹 [SYSTEM] Ejecutando Limpieza Profunda de Memoria (Garbage Collector)...");
    const now = Date.now();

    // 1. Limpiar priceHistoryCache (Mercados que ya no están en la Watchlist)
    const activeTokens = new Set();
    botStatus.watchlist.forEach(m => {
        if (m.tokenYes) activeTokens.add(m.tokenYes);
        if (m.tokenNo) activeTokens.add(m.tokenNo);
    });

    for (const tokenId in priceHistoryCache) {
        if (!activeTokens.has(tokenId)) {
            delete priceHistoryCache[tokenId]; // Borra el token muerto de la RAM
        }
    }

    // 2. Limpiar botStatus.lastTrades (Cooldowns antiguos mayores a 24 horas)
    for (const tokenId in botStatus.lastTrades) {
        if (now - botStatus.lastTrades[tokenId] > 24 * 60 * 60 * 1000) {
            delete botStatus.lastTrades[tokenId]; // Borra el registro histórico
        }
    }
}

// ==========================================
// 🛡️ GUARDIÁN DE SALUD DEL SERVIDOR (AUTO-HEALING)
// ==========================================
let lastHealthAlertTime = 0; 

export async function monitorSystemHealth() {
    try {
        const now = Date.now();
        const botRamMB = process.memoryUsage().rss / 1024 / 1024;
        const cpuLoad = os.loadavg()[0];

        // Umbrales de Peligro
        const RAM_LIMIT = 700; // Alerta y reinicio si pasa de 700 MB
        const CPU_LIMIT = 1.5; // Alerta si la carga promedio pasa de 1.5

        let alertMsg = "";
        let shouldAutoRestart = false;

        // 1. Verificación de RAM (Disparador de Auto-Healing)
        if (botRamMB > RAM_LIMIT) {
            alertMsg += `⚠️ *Fuga de Memoria Detectada*\nEl Poly-Bot está consumiendo \`${botRamMB.toFixed(0)} MB\` de RAM.\n\n`;
            shouldAutoRestart = true; 
        }

        // 2. Verificación de CPU (Solo Alerta)
        if (cpuLoad > CPU_LIMIT) {
            alertMsg += `🔥 *Sobrecarga de Procesador*\nEl CPU de Toronto está al \`${cpuLoad.toFixed(2)}\` (Riesgo de Lag).\n\n`;
        }

        // 3. Ejecución de Acciones
        if (alertMsg !== "") {
            // Evitamos saturar Telegram si no es un reinicio inminente
            if (now - lastHealthAlertTime < 3600000 && !shouldAutoRestart) return;

            const actionText = shouldAutoRestart 
                ? `*Acción:* Ejecutando Auto-Reinicio (Auto-Healing) ahora mismo 🔄` 
                : `*Acción recomendada:* Monitorear o reiniciar manualmente si persiste.`;

            // 5. ALERTA DE INFRAESTRUCTURA
            await sendAlert(
                `🚨 *ALERTA DE INFRAESTRUCTURA* 🚨\n\n` +
                `${alertMsg}\n` +
                `${actionText}\n\n` +
                `💻 RAM Bot: *${botRamMB.toFixed(0)} MB*`
            );

            lastHealthAlertTime = now;
            console.log(shouldAutoRestart ? "🔄 [SISTEMA] Iniciando Auto-Healing..." : "🚨 [SISTEMA] Alerta de salud enviada.");

            // 🔥 EL CORAZÓN DEL AUTO-HEALING
            if (shouldAutoRestart) {
                // Esperamos 3 segundos para asegurar que el mensaje de Telegram se envíe correctamente
                setTimeout(() => {
                    console.log("💀 Matando proceso para reinicio limpio por PM2...");
                    process.exit(1); 
                }, 3000);
            }
        }
    } catch (error) {
        console.error("❌ Error en monitorSystemHealth:", error.message);
    }
}