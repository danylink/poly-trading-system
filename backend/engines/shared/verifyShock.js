// engines/shared/verifyShock.js
import { analyzeMarketWithClaude, analyzeMarketWithGemini, analyzeMarketWithGrok } from '../../utils/ia.js';
import { executeTradeOnChain } from '../../services/polymarketService.js';
import { botStatus } from '../../config.js';

export async function verifyShockWithIA(marketData, eventProbabilityChange, triggerPrice, shockTokenId, outcomeToBuy) {
    const direction = eventProbabilityChange > 0 ? "AUMENTADO" : "CAÍDO";
    const newsString = await getLatestNews(marketData.title, marketData.category); 
    
    const flashPrompt = `
        [ALERTA DE SHOCK DE LIQUIDEZ]: La probabilidad de que ocurra el evento "${marketData.title}" ha ${direction} bruscamente un ${Math.abs(eventProbabilityChange).toFixed(1)}% en 5 minutos.
        Noticias recientes: "${newsString || 'Ninguna noticia relevante'}".
        INSTRUCCIÓN VITAL: Si este salto brusco de probabilidad NO tiene sentido y es puro pánico humano/error de dedo en el mercado, tu "recommendation" debe ser "WAIT" y tu "reason" debe decir "Pánico irracional". Si el cambio SÍ está justificado por las noticias reales, tu "recommendation" debe ser "BUY".
    `;

    try {
        console.log(`🧠 [EQUALIZER] Consultando a Claude (Vía Rápida)...`);
        let result;
        const claudeResponse = await analyzeMarketWithClaude(marketData.title, flashPrompt, 1);
        
        if (!claudeResponse.isError) {
             result = { isJustified: claudeResponse.recommendation !== "WAIT", reason: claudeResponse.reason, confidence: (claudeResponse.prob * 100) || 80 };
        } else {
             console.log(`⚠️ [EQUALIZER] Claude falló. Lanzando a Gemini...`);
             const geminiResponse = await analyzeMarketWithGemini(marketData.title, flashPrompt, 1);
             
             if (!geminiResponse.isError) {
                 result = { isJustified: geminiResponse.recommendation !== "WAIT", reason: geminiResponse.reason, confidence: (geminiResponse.prob * 100) || 80 };
             } else {
                 console.log(`⚠️ [EQUALIZER] Gemini falló. Lanzando a Grok...`);
                 const grokResponse = await analyzeMarketWithGrok(marketData.title, flashPrompt, 1);
                 
                 if (!grokResponse.isError) {
                     result = { isJustified: grokResponse.recommendation !== "WAIT", reason: grokResponse.reason, confidence: (grokResponse.prob * 100) || 80 };
                 } else {
                     console.log(`❌ [EQUALIZER ABORTADO] Las 3 APIs están caídas. No disparamos a ciegas.`);
                     delete priceHistoryCache[shockTokenId];
                     return; 
                 }
             }
        }

        if (result.isJustified === false && result.confidence >= 75) {
            console.log(`📉 [EQUALIZER] IA Confirma Pánico Humano (Confianza: ${result.confidence.toFixed(0)}%). Razón: ${result.reason}`);
            
            const currentLivePrice = await getMarketPrice(shockTokenId) || (outcomeToBuy === "YES" ? marketData.priceYes : marketData.priceNo);
            // 🔥 FIX QUANT: La fórmula de descuento ahora es correcta para ambos lados
            const expectedDiscountPrice = outcomeToBuy === "YES" ? triggerPrice : (1 - triggerPrice);
            
            if (parseFloat(currentLivePrice) > expectedDiscountPrice + 0.03) {
                console.log(`⚠️ [EQUALIZER ABORTADO] El mercado ya se corrigió. Esperado: $${expectedDiscountPrice.toFixed(2)}, Actual: $${currentLivePrice}.`);
                delete priceHistoryCache[shockTokenId];
                return;
            }

            await executeEqualizerTrade(marketData, outcomeToBuy);
            delete priceHistoryCache[shockTokenId];
        } else {
            console.log(`⏩ [EQUALIZER IGNORADO] Movimiento justificado por noticias reales. Razón: ${result.reason}`);
            delete priceHistoryCache[shockTokenId]; 
        }
    } catch (err) {
        console.error("❌ Error en IA Equalizer:", err.message);
        delete priceHistoryCache[shockTokenId]; 
    }
}