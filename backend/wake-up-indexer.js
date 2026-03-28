import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

async function shock() {
    // 🌐 Forzamos la detección de la red Polygon (137)
    const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com", {
        name: 'polygon',
        chainId: 137
    });

    const privateKey = process.env.POLY_PRIVATE_KEY?.trim();
    if (!privateKey) {
        console.error("❌ No hay llave privada en el .env");
        return;
    }

    const wallet = new ethers.Wallet(privateKey, provider);
    const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    const abi = ["function transfer(address to, uint256 amount) returns (bool)"];
    const usdc = new ethers.Contract(USDC_NATIVE, abi, wallet);

    console.log("⚡ Iniciando Electroshock Robusto...");
    
    try {
        // 📡 Verificamos conexión antes de disparar
        const network = await provider.getNetwork();
        console.log(`🔗 Conectado a red: ${network.name} (ID: ${network.chainId})`);

        console.log("📨 Enviando 0.01 USDC a mi propia dirección:", wallet.address);

        const amount = ethers.utils.parseUnits("0.01", 6);
        
        // Añadimos gas manual para evitar errores de estimación
        const tx = await usdc.transfer(wallet.address, amount, {
            maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
            maxFeePerGas: ethers.utils.parseUnits("150", "gwei")
        });
        
        console.log("📡 Transacción enviada. Hash:", tx.hash);
        console.log("⏳ Esperando confirmación...");
        await tx.wait();
        console.log("✅ ¡ELECTROSHOCK COMPLETADO!");
        
        console.log("\n🏛️ DANI: Espera 30 segundos y corre 'node debug-wallet.js'.");
    } catch (e) {
        console.error("❌ Error en el shock:", e.message);
        console.log("\n💡 TIP: Si el error persiste, revisa que tu internet no esté bloqueando el puerto RPC.");
    }
}
shock();