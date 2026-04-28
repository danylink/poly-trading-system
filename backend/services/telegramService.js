// services/telegramService.js
import TelegramBot from 'node-telegram-bot-api';
const telegram = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;

export async function sendAlert(message) {
    try {
        await telegram.sendMessage(chatId, `🤖 *PolySniper*:\n\n${message}`, { parse_mode: 'Markdown' });
    } catch (e) {}
}

// 🟢 FUNCIÓN MEJORADA - SNIPER ALERT CON ORIGEN DEL MODELO
export async function sendSniperAlert(signal) {

    const edgePct = signal.edge >= 0 ? `+${(signal.edge * 100).toFixed(1)}%` : `${(signal.edge * 100).toFixed(1)}%`;

    // 🔥 NUEVO: Mostrar el origen del modelo de forma clara y bonita
    let origen = signal.engine || "Desconocido";

    // Si es consenso, lo hacemos más legible
    if (origen.includes("Trinity") || origen.includes("Consenso")) {
        origen = `🔥 ${origen}`;
    } else if (["Claude", "Gemini", "Grok"].includes(origen)) {
        origen = `🧠 ${origen}`;
    }

    const msg = `🎯 *SNIPER AUTOMÁTICO EJECUTADO*\n\n` +
                `📋 *Mercado:* ${signal.marketName}\n` +
                `🔍 *Modelo:* ${origen}\n` +                    // ← NUEVA LÍNEA
                `🧠 *Confianza IA:* ${(signal.probability * 100).toFixed(0)}%\n` +
                `📊 *Precio de Compra:* $${signal.marketPrice}\n` +
                `📈 *Ventaja (Edge):* ${edgePct}\n` +
                `💰 *Inversión:* $${(signal.suggestedInversion).toFixed(2)} USDC\n` +
                `📝 *Razón:* ${signal.reasoning}`;

    try { 
        await telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' }); 
    } catch (e) { 
        console.error('❌ Error enviando alerta de Telegram:', e.message); 
    }
}

// ==========================================
// FUNCIÓN AUXILIAR PARA ALERTAS DE COPY TRADING (BUY + SELL)
export async function sendCopyAlert(type, whaleName, marketTitle, amount) {
    let emoji = '';
    let titulo = '';

    if (type === 'BUY') {
        emoji = '🐋';
        titulo = '*COPY BUY*';
        amount = `Inversión: *$${amount}* USDC`;
    } else if (type === 'SELL') {
        emoji = '🛑';
        titulo = '*COPY SELL*';
        amount = `Rescatado: *$${amount}* USDC`;
    }

    const marketClean = marketTitle.length > 68 
        ? marketTitle.substring(0, 65) + '...' 
        : marketTitle;

    const msg = `${emoji} ${titulo}\n\n` +
                `📛 *Ballena:* ${whaleName}\n` +
                `📋 *Mercado:* ${marketClean}\n` +
                `💰 ${amount}`;

    try {
        await telegram.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(`❌ Error enviando alerta COPY ${type}:`, e.message);
    }
}