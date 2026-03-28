import { ClobClient, Chain } from "@polymarket/clob-client";
import { Wallet, providers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    const provider = new providers.StaticJsonRpcProvider("https://polygon-rpc.com");
    const wallet = new Wallet(process.env.POLY_PRIVATE_KEY, provider);
    const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

    const creds = {
        key:        process.env.POLY_API_KEY?.trim(),
        secret:     process.env.POLY_SECRET?.trim(),
        passphrase: process.env.POLY_PASSPHRASE?.trim(),
    };

    console.log(`🕵️ Wallet: ${wallet.address}`);
    
    // PROBAMOS 3 DESFASES DE TIEMPO (0, -1 segundo, +1 segundo)
    const drifts = [0, -1000, 1000]; 

    for (let drift of drifts) {
        try {
            console.log(`\n📡 Intentando conexión (Drift: ${drift}ms)...`);
            
            const client = new ClobClient(
                "https://clob.polymarket.com",
                Chain.POLYGON,
                wallet,
                creds,
                2
            );

            // Intentamos forzar el balance
            const resp = await client.getBalanceAllowance({
                asset_type: "COLLATERAL",
                collateral_address: USDC_NATIVE
            });

            if (resp.balance) {
                console.log("\n✅ ¡LO LOGRAMOS, DANI! CONEXIÓN ESTABLECIDA.");
                console.log(`💰 Balance: ${parseFloat(resp.balance) / 1000000} USDC`);
                return; // Éxito total
            } else {
                console.log(`❌ Intento fallido: ${resp.error}`);
            }
        } catch (e) {
            console.log(`⚠️ Error en este intento: ${e.message}`);
        }
        
        // Esperamos un segundo antes de reintentar con otro drift
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log("\n🛑 Si todos fallaron: Verifica que no haya COMILLAS en tu .env.");
}

main();