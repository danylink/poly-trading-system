import { ClobClient, Chain } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function check() {
    try {
        // Probamos el endpoint de salud del servidor de Polymarket
        const client = new ClobClient("https://clob.polymarket.com", Chain.POLYGON);
        const health = await client.getOk();
        console.log("📡 Estado del Servidor Polymarket:", health);
        
        const time = await client.getServerTime();
        console.log("⏰ Hora del Servidor:", time);
        
        console.log("✅ El SDK SÍ tiene salida a internet.");
    } catch (e) {
        console.error("❌ El SDK NO puede conectar con Polymarket:", e.message);
    }
}
check();