// test-viem.js
import { createWalletClient, http } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ClobClient, Side } from '@polymarket/clob-client';
import dotenv from 'dotenv';

dotenv.config();

const PROXY_WALLET = "0x9604a684016561E83c1bE87028dbcD1ad382aA5E";

async function testViemTrade() {
    const privateKey = process.env.POLY_PRIVATE_KEY;
    if (!privateKey) throw new Error("Falta POLY_PRIVATE_KEY");

    const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);

    console.log("✅ Cuenta cargada:", account.address);

    // Crear cliente viem
    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(process.env.POLYGON_RPC_URL)
    });

    // ... (código anterior igual)

    // 1. Primero derivamos las credenciales con un cliente temporal
    const tempClient = new ClobClient(
        "https://clob.polymarket.com",
        137,
        walletClient, // Tu walletClient de viem
        null,
        2,
        PROXY_WALLET
    );

    const apiCreds = await tempClient.createOrDeriveApiKey();
    console.log("✅ API Credentials derivadas:", apiCreds.key);

    // 2. AHORA creamos el cliente definitivo PASANDO las credenciales
    const clobClient = new ClobClient(
        "https://clob.polymarket.com",
        137,
        walletClient,
        apiCreds, // ← AQUÍ metemos las credenciales para que no sean null
        2,
        PROXY_WALLET
    );

    // ... (resto del código de compra)

    const TOKEN_ID = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
    const PRICE = 0.55;
    const SIZE = 2.0;

    try {
        console.log(`🛒 Intentando comprar ${SIZE} shares a $${PRICE}...`);

        const order = await clobClient.createOrder({
            tokenID: TOKEN_ID,
            price: PRICE,
            side: Side.BUY,
            size: SIZE,
            feeRateBps: 1000,
            collateralAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
        });

        const response = await clobClient.postOrder(order);

        if (response?.success) {
            console.log(`🎉 ¡ÉXITO! Order ID: ${response.orderID}`);
        } else {
            console.log("❌ Rechazada:", response);
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
        if (error.response?.data) console.error("Detalles:", JSON.stringify(error.response.data, null, 2));
    }
}

testViemTrade().catch(console.error);