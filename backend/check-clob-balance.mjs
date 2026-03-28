import { ClobClient, Chain } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

const tempClob = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet);
console.log("Derivando API Keys...");
const creds = await tempClob.deriveApiKey();

const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, creds, 0);

console.log("=== CONSULTANDO CLOB BALANCE-ALLOWANCE ===");

// Consultar USDC balance/allowance
const usdcBA = await clobClient.getBalanceAllowance({ asset_type: 'USDC' });
console.log("USDC visto por CLOB:", JSON.stringify(usdcBA, null, 2));

// Consultar el token específico del mercado
const TOKEN_ID = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
try {
    const tokenBA = await clobClient.getBalanceAllowance({ 
        asset_type: 'CONDITIONAL',
        token_id: TOKEN_ID
    });
    console.log("Token CONDITIONAL visto por CLOB:", JSON.stringify(tokenBA, null, 2));
} catch(e) {
    console.log("Error consultando token conditional:", e.message);
}
