// debug-clob-usdc.mjs — verifica qué ve el CLOB sobre el balance USDC
import { ClobClient, Chain } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

const tempClob = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet);
const creds = await tempClob.deriveApiKey();
const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, creds, 0);

// 1. Verificar qué headers envía el SDK para autenticación
console.log("Creds:", JSON.stringify(creds));

// 2. Intentar GET /balance-allowance?asset_type=USDC directamente con axios autenticado
const l1Headers = await clobClient.createL1Headers();
console.log("\nL1 Headers:", JSON.stringify(l1Headers, null, 2));

try {
    const resp = await axios.get('https://clob.polymarket.com/balance-allowance', {
        params: { asset_type: 'USDC' },
        headers: { ...l1Headers }
    });
    console.log("\nUSDC Balance-Allowance (CLOB):", JSON.stringify(resp.data, null, 2));
} catch(e) {
    console.log("Error USDC BA:", e.response?.data || e.message);
}

// 3. También el método del SDK
try {
    const ba = await clobClient.getBalanceAllowance({ asset_type: 'USDC' });
    console.log("\nSDK USDC BA:", JSON.stringify(ba, null, 2));
} catch(e) {
    console.log("Error SDK USDC BA:", e.message);
}
