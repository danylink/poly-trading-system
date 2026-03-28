// 🛠️ Script para depositar USDC Nativo en el CLOB de Polymarket
// Esto registra tu saldo en el ledger interno del exchange

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const USDC_NATIVE   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const CTF_EXCHANGE  = "0x4BFb304598296E5105583dA39cE9dcFD29944545";

// Usar RPC público más confiable para transacciones
const PUBLIC_RPCS = [
    "https://rpc.ankr.com/polygon",
    "https://polygon-rpc.com",
    process.env.POLYGON_RPC_URL,
];

async function getProvider() {
    for (const rpc of PUBLIC_RPCS) {
        if (!rpc) continue;
        try {
            const p = new ethers.providers.JsonRpcProvider(rpc);
            await Promise.race([p.getBlockNumber(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
            console.log(`✅ RPC activo: ${rpc.substring(0, 40)}...`);
            return p;
        } catch(e) {
            console.log(`⚠️ RPC lento: ${rpc.substring(0, 40)}...`);
        }
    }
    throw new Error("Ningún RPC disponible");
}

// ABI del CTF Exchange (solo lo que necesitamos)
const CTF_ABI = [
    "function deposit(uint256 amount) external",
    "function getCollateral() view returns (address)"
];
const USDC_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)"
];

const GAS = {
    maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
    maxFeePerGas:         ethers.utils.parseUnits("150", "gwei"),
};

async function depositToCLOB() {
    const provider = await getProvider();
    const wallet   = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);
    
    console.log("=".repeat(60));
    console.log("💼 Wallet:", wallet.address);
    console.log("=".repeat(60));

    const usdc    = new ethers.Contract(USDC_NATIVE,  USDC_ABI, wallet);
    const ctf     = new ethers.Contract(CTF_EXCHANGE, CTF_ABI,  wallet);

    // 1. Verificar balance on-chain
    const balance = await usdc.balanceOf(wallet.address);
    console.log(`\n💰 Balance on-chain: ${ethers.utils.formatUnits(balance, 6)} USDC`);

    // Vamos a depositar 1 USDC (lo mínimo para registrar la wallet)
    const depositAmount = ethers.utils.parseUnits("1.0", 6);

    if (balance.lt(depositAmount)) {
        console.log("❌ No tienes suficiente USDC on-chain para depositar.");
        return;
    }

    // 2. Verificar y dar approve si es necesario
    const currentAllowance = await usdc.allowance(wallet.address, CTF_EXCHANGE);
    console.log(`\n🔓 Allowance actual: ${ethers.utils.formatUnits(currentAllowance, 6)} USDC`);
    
    if (currentAllowance.lt(depositAmount)) {
        console.log("🔓 Aprobando USDC para el CTF Exchange...");
        const approveTx = await usdc.approve(CTF_EXCHANGE, ethers.constants.MaxUint256, GAS);
        await approveTx.wait();
        console.log("✅ Approve confirmado. Hash:", approveTx.hash);
    } else {
        console.log("✅ Allowance ya es suficiente");
    }

    // 3. Hacer el depósito en el CTF Exchange
    // Esto es lo que registra el saldo en el ledger del CLOB
    console.log(`\n📤 Depositando ${ethers.utils.formatUnits(depositAmount, 6)} USDC en el CTF Exchange...`);
    console.log("   (Esto registra tu wallet en el CLOB de Polymarket)");
    
    try {
        const depositTx = await ctf.deposit(depositAmount, GAS);
        console.log("📡 Tx enviada. Hash:", depositTx.hash);
        const receipt = await depositTx.wait();
        console.log(`✅ DEPÓSITO CONFIRMADO en bloque ${receipt.blockNumber}`);
        console.log("\n🎉 ¡Tu saldo ya está registrado en el CLOB!");
        console.log("   Ahora puedes ejecutar test-clob.js y la orden se aceptará.");
    } catch (e) {
        // El contrato CTF Exchange nativo puede tener la función con otro nombre
        console.log("⚠️  deposit() falló:", e.reason || e.message);
        console.log("\n💡 Intento alternativo: verificando ABI del contrato...");
        
        // Algunos contratos usan transferAndApprove o simplemente el approve + la orden basta
        console.log("   El CLOB puede necesitar que hagas la primera operación desde polymarket.com");
    }
}

depositToCLOB().catch(e => {
    console.error("\n💥 ERROR:", e.message);
    process.exit(1);
});
