import TelegramBot from 'node-telegram-bot-api';
import * as dotenv from 'dotenv';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

const bot = new TelegramBot(token);

async function test() {
    console.log("--- Enviando mensaje de prueba a Telegram ---");
    try {
        const message = "👋 ¡Hola Dany! Tu PolyBot está configurado correctamente. Recibirás alertas aquí cuando ejecute órdenes en Polymarket.";
        await bot.sendMessage(chatId, message);
        console.log("✅ ¡Mensaje enviado! Revisa tu celular.");
    } catch (error) {
        console.error("❌ Error al enviar mensaje:", error.message);
        console.log("\nTips de solución:");
        console.log("1. Verifica que el TOKEN en el .env sea correcto.");
        console.log("2. Asegúrate de haberle dado '/start' a tu bot en Telegram.");
    }
}

test();
