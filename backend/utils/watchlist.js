// utils/watchlist.js
import axios from 'axios';
import { botStatus } from '../config.js';
import { getMarketCategoryEnhanced, isMarketAllowed } from './helpers.js';
import { API_ENDPOINTS } from '../constants.js';

export async function refreshWatchlist() {
    try {
        console.log(`\n⏰ [SNIPER] Actualizando Watchlist...`);

        const res = await axios.get(API_ENDPOINTS.GAMMA_MARKETS);

        const now = Date.now();
        const activeMarkets = res.data.filter(m => m.conditionId && m.endDate).map(m => ({
            ...m,
            category: getMarketCategoryEnhanced(m.question),
            endTime: new Date(m.endDate).getTime(),
            hoursLeft: (new Date(m.endDate).getTime() - now) / (1000 * 60 * 60)
        }));

        // Macro Watchlist (Ballenas) - Corto plazo
        const MAX_HOURS_COPY = (botStatus.maxCopyDaysForWhales || 15) * 24;
        const macroPool = activeMarkets.filter(m => {
            if (parseFloat(m.volume || 0) < 1500) return false;
            if (m.hoursLeft > MAX_HOURS_COPY) return false;
            return true;
        }).slice(0, 500);

        console.log(`🐋 [MACRO] Ballenas → ${macroPool.length} mercados cortos (máx ${MAX_DAYS_FOR_COPY} días)`);

        // Guardamos la memoria macro en bruto
        botStatus.macroWatchlist = macroPool.map(market => {
            const tokens = JSON.parse(market.clobTokenIds || "[]");
            return {
                title: market.question,
                conditionId: market.conditionId,
                tokenIdYes: tokens[0] || null,
                tokenIdNo: tokens[1] || null
            };
        });

        // ===============================================================
        // 🧠 CONSTRUCCIÓN DE LA MICRO-WATCHLIST (El Menú de la IA)
        // ===============================================================
        let highQuality = [];   // Política, Trump, Fed, Geopolítica, Business
        let shortTermCrypto = []; // Crypto corto y Up or Down

        for (const market of activeMarkets) {
            // IA solo mira mercados muy líquidos (>$2000) y que no hayan expirado
            if (parseFloat(market.volume || 0) < 2000 || market.endTime < now) continue;

            const cat = market.category || "";

            if (["POLITICS", "BUSINESS", "GEOPOLITICS", "TRUMP", "FED", "CPI", "IRAN", "UKRAINE", "ISRAEL"].includes(cat)) {
                // IA: Política y Macro a 30 días máximo (720 hrs)
                if (market.hoursLeft <= 720) highQuality.push(market);
            } 
            else if (cat === "CRYPTO" || cat === "SHORT_TERM" || market.question.toLowerCase().includes("up or down") || market.question.toLowerCase().includes("above")) {
                // IA: Crypto o volatilidad a 4 días máximo (96 hrs)
                if (market.hoursLeft <= 96) shortTermCrypto.push(market);
            }
        }

        // Ordenamos y limitamos el menú de la IA
        highQuality.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));
        shortTermCrypto.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));
        
        shortTermCrypto = shortTermCrypto.slice(0, 6);   // Máximo 6 mercados crypto corto
        const finalPool = [...highQuality.slice(0, 40), ...shortTermCrypto];  

        // Convertimos al formato rico que necesita el bot para operar
        botStatus.watchlist = finalPool.map(market => {
            const tokens = JSON.parse(market.clobTokenIds || "[]");
            const prices = JSON.parse(market.outcomePrices || "[]");

            return {
                title: market.question,
                category: market.category,
                conditionId: market.conditionId,
                tokenYes: tokens[0] || null,
                tokenNo: tokens[1] || null,
                priceYes: parseFloat(prices[0] || 0),
                priceNo: parseFloat(prices[1] || 0),
                tokenId: tokens[0] || null,
                marketPrice: parseFloat(prices[0] || 0),
                endDate: market.endDate, 
                endsIn: market.hoursLeft < 1 ? `${Math.round(market.hoursLeft*60)}m` : `${market.hoursLeft.toFixed(1)}h`,
                tickSize: market.minimum_tick_size || "0.01",
                volume: parseFloat(market.volume || 0)
            };
        });

        console.log(`🎯 [DUAL-CACHE] Macro (Ballenas): ${macroPool.length} | Micro (IA): ${botStatus.watchlist.length}`);
    } catch (e) {
        console.error('❌ Error refreshWatchlist:', e.message);
    }
}