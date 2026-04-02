// 🛠️ FIX: Inyectar Web Crypto API antes que cualquier import del SDK
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = webcrypto;
}

import { ClobClient, Chain, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

// ===================================================================
// Mercado de prueba (Russia x Ukraine ceasefire)
// ===================================================================
const TOKEN_ID  = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
const PRICE     = 0.0045;
const SIZE      = 3.00;   // Pequeño — solo es una prueba

// Contratos Polygon Mainnet — USDC Nativo
const USDC_NATIVE     = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const CTF_EXCHANGE    = "0x4BFb304598296E5105583dA39cE9dcFD29944545";
const NEG_RISK        = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const USDC_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)"
];

const GAS = {
    maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
    maxFeePerGas:         ethers.utils.parseUnits("150", "gwei"),
};

// RPC robusto con redundancia
const PUBLIC_RPCS = [
    process.env.POLYGON_RPC_URL, // Alchemy (si funciona)
    "https://rpc.ankr.com/polygon",
    "https://polygon-rpc.com"
];

async function getStableProvider() {
    for (const rpc of PUBLIC_RPCS) {
        if (!rpc) continue;
        try {
            const p = new ethers.providers.JsonRpcProvider(rpc);
            await Promise.race([
                p.getBlockNumber(), 
                new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 12000))
            ]);
            console.log(`✅ RPC conectado: ${rpc.substring(0, 30)}...`);
            return p;
        } catch(e) {
            console.log(`⚠️ RPC fallido: ${rpc.substring(0, 30)}...`);
        }
    }
    throw new Error("❌ No se pudo conectar a ningún RPC de Polygon");
}

async function testTrade() {
    const provider = await getStableProvider();
    const wallet   = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

    // Instanciando el cliente. Probaremos los 3 tipos de firma si uno falla.
    const creds = await (new ClobClient("https://clob.polymarket.com", Chain.POLYGON, wallet)).deriveApiKey();
    const createTypedClient = (sigType) => {
        const client = new ClobClient(
            "https://clob.polymarket.com",
            Chain.POLYGON,
            wallet,
            creds,
            sigType
        );

        // 🔥 EL DOMINIO EXACTO QUE ESPERA EL NODO PARA USDC NATIVO
        client.getContractConfig = () => ({
            name: "ClobExchange", // Polymarket mantuvo este nombre internamente
            version: "1",
            chainId: 137,
            verifyingContract: "0x4BFb304598296E5105583dA39cE9dcFD29944545" // Exchange Nativo
        });

        return client;
    };

    // ── 3. COMPROBAR Y APROBAR ALLOWANCES (VERSIÓN BLINDADA 2026) ──
    console.log("\n[3/4] Verificando los 3 Pilares de USDC Nativo...");

    const usdc = new ethers.Contract(USDC_NATIVE, USDC_ABI, wallet);

    // Estas 3 direcciones son las que el CLOB te marcó con "0" en el error
    const targets = [
        ["CTF Exchange (New)", "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"], 
        ["Clob Auth",         "0xC5d563A36AE78145C45a50134d48A1215220f80a"],
        ["NegRisk Adapter",   "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"]
    ];

    for (const [name, addr] of targets) {
        const allow = await usdc.allowance(wallet.address, addr);
        if (allow.lt(ethers.utils.parseUnits("10", 6))) { // Si es menor a 10 USDC
            console.log(`  🔓 Aprobando ${name} (${addr})...`);
            const tx = await usdc.approve(addr, ethers.constants.MaxUint256, GAS);
            await tx.wait();
            console.log(`  ✅ ${name} Aprobado.`);
        } else {
            console.log(`  ✅ ${name} ya tiene permiso.`);
        }
    }

    // ── 4. BALANCE CLOB (VERSIÓN FORZADA) ──────────────────────────
    console.log("\n[4/4] Forzando Sincronización de Balance...");
    try {
        const checkClient = createTypedClient(0); 

        // 1. LE DECIMOS AL SERVIDOR: "MIRA MI WALLET AHORA"
        // Intentamos actualizar el registro del servidor con la blockchain
        await checkClient.updateBalanceAllowance({
            asset_type: "COLLATERAL",
            collateral_address: USDC_NATIVE
        });
        
        console.log("🔄 Sincronización enviada al servidor...");

        // Esperamos 2 segundos a que el servidor procese
        await new Promise(r => setTimeout(r, 2000));

        // 2. CONSULTAMOS DE NUEVO
        const data = await checkClient.getBalanceAllowance({
            asset_type: "COLLATERAL",
            collateral_address: USDC_NATIVE
        });
        
        console.log(`💰 Resultado del CLOB:`);
        console.log(`   - Balance: ${data.balance}`);
        console.log(`   - Allowances: ${JSON.stringify(data.allowances)}`);

        if (data.balance === "0" && Object.values(data.allowances).every(v => v === "0")) {
            console.log("❌ El servidor sigue sin ver tus USDC.");
            console.log("💡 SOLUCIÓN MANUAL REQUERIDA:");
            console.log("1. Ve a Polymarket.com");
            console.log("2. Dale a 'Deposit' -> 'Polygon' -> 'USDC'.");
            console.log("3. Si ves un botón 'Enable USDC', dale CLICK.");
        }
    } catch (e) {
        console.warn("⚠️ Error en sync:", e.message);
    }

    // ── 5. ORDEN REAL ──────────────────────────────────────────────
    console.log("\n[5/5] Enviando orden con createAndPostOrder...");
    const tradeClient = createTypedClient(0);

    try {
        // En tu versión, podemos usar esta función "todo en uno"
        const response = await tradeClient.createAndPostOrder({
            tokenID:           TOKEN_ID,
            price:             PRICE,
            side:              Side.BUY,
            size:              SIZE,
            feeRateBps:        0,
            collateralAddress: USDC_NATIVE,
        });

        if (response && response.success) {
            console.log(`\n🎉 ¡SNIPE EXITOSO! OrderID: ${response.orderID}`);
        } else {
            console.log(`\n❌ RECHAZADA:`, JSON.stringify(response, null, 2));
        }
    } catch (e) {
        console.error(`💥 Error en ejecución:`, e.message);
    }

    // 🔍 --- ESCÁNER DE FUNCIONES (Solo para diagnóstico) ---
    /*
    console.log("\n🧪 EXAMINANDO MÉTODOS DISPONIBLES EN TU SDK v5.8.1...");
    const clientParaEscaneo = createTypedClient(0);
    
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(clientParaEscaneo))
        .filter(m => !m.startsWith('_'));
    
    console.log("🚀 FUNCIONES DETECTADAS:");
    console.log(JSON.stringify(methods, null, 2));

    console.log("\n📦 SUBMÓDULOS (Namespaces):");
    for (let key in clientParaEscaneo) {
        if (typeof clientParaEscaneo[key] === 'object' && clientParaEscaneo[key] !== null) {
            console.log(`- ${key}`);
        }
    }
    */
}

testTrade().catch(e => {
    console.error("\n💥 EXCEPCIÓN FATAL:", e.message);
    if (e.response) console.error("Respuesta HTTP:", JSON.stringify(e.response.data));
    process.exit(1);
});
