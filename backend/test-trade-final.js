// test-trade-signature-fix.js
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { ClobClient, Chain, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const PROXY_WALLET = "0x9604a684016561E83c1bE87028dbcD1ad382aA5E";

async function testTrade() {
    const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

    console.log("✅ Wallet conectada:", wallet.address);

    // Derivar credenciales
    const tempClient = new ClobClient("https://clob.polymarket.com", Chain.POLYGON, wallet);
    const apiCreds = await tempClient.createOrDeriveApiKey();

    console.log("✅ API Credentials obtenidas");

    // Configuración más estable actual para cuentas MetaMask
    const client = new ClobClient(
        "https://clob.polymarket.com",
        Chain.POLYGON,
        wallet,
        apiCreds,
        2,                    // ← Probamos con 1 (POLY_PROXY)
        PROXY_WALLET
    );

    console.log("✅ Cliente creado con signatureType: 1 + Proxy Wallet\n");

    const TOKEN_ID = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
    const PRICE = 0.55;
    const SIZE = 2.0;

    try {
        console.log(`🛒 Intentando comprar ${SIZE} shares a $${PRICE}...`);

        const order = await client.createOrder({
            tokenID: TOKEN_ID,
            price: PRICE,
            side: Side.BUY,
            size: SIZE,
            feeRateBps: 1000,
            collateralAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
        });

        const response = await client.postOrder(order);

        if (response?.success) {
            console.log(`\n🎉 ¡ORDEN ACEPTADA! Order ID: ${response.orderID}`);
        } else {
            console.log(`❌ Orden rechazada:`, response);
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
        if (error.response?.data) {
            console.error("Detalles completos:", JSON.stringify(error.response.data, null, 2));
        }
    }
}

testTrade().catch(e => {
    console.error("💥 Error fatal:", e.message);
});