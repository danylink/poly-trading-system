import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import 'dotenv/config';

const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY);
console.log("Wallet:", wallet.address);

const client = new ClobClient("https://clob.polymarket.com", 137, wallet);

console.log("--- FUNCIONES DISPONIBLES EN EL CLIENTE ---");
console.log(Object.keys(client).filter(k => typeof client[k] === 'function'));

// Verifica si existe la función de validación de firma
if (client.getTradeSignature) {
    console.log("✅ getTradeSignature existe");
} else {
    console.log("❌ getTradeSignature no existe (posible cambio de versión)");
}