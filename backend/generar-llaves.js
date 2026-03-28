import { ClobClient } from "@polymarket/clob-client";
import { Chain } from "@polymarket/clob-client"; // O impórtalos juntos
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

async function generar() {
    // Usamos el RPC de Polygon
    const provider = new ethers.providers.StaticJsonRpcProvider("https://polygon-rpc.com");
    
    // Verificamos que la Private Key exista
    const privateKey = process.env.POLY_PRIVATE_KEY?.trim();
    if (!privateKey) {
        console.error("❌ No se encontró POLY_PRIVATE_KEY en el .env");
        return;
    }

    const wallet = new ethers.Wallet(privateKey, provider);

    // Cliente para generar las llaves (aquí no pasamos el objeto auth todavía)
    const client = new ClobClient(
        "https://clob.polymarket.com",
        Chain.POLYGON,
        wallet
    );

    try {
        console.log("🔐 Generando vínculo oficial para:", wallet.address);
        
        // Generamos la respuesta
        const resp = await client.createApiKey();
        
        // Esto nos mostrará qué nombres está usando el servidor realmente
        console.log("\n🔍 Estructura recibida:", JSON.stringify(resp, null, 2));

        console.log("\n✅ ¡LLAVES VINCULADAS CON ÉXITO!");
        console.log("-----------------------------------------");
        // Intentamos con los nombres más comunes si vienen anidados
        const apiKey = resp.apiKey || resp.key || "No encontrada";
        const secret = resp.secret || "No encontrado";
        const passphrase = resp.passphrase || "No encontrada";

        console.log(`POLY_API_KEY=${apiKey}`);
        console.log(`POLY_SECRET=${secret}`);
        console.log(`POLY_PASSPHRASE=${passphrase}`);
        console.log("-----------------------------------------");

    } catch (e) {
        console.error("❌ Error al generar:", e.message);
    }
}

generar();