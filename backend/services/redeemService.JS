// services/redeemService.js - Funciones de Redeem (Gasless y Directo)
import { botStatus, saveConfigToDisk } from '../config.js';
import { sendAlert } from './telegramService.js';
import { updateRealBalances } from './balanceService.js';
import { ethers } from 'ethers';

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

let isRedeeming = false;

// ==========================================
// REDEEM DIRECTO (Paga Gas)
// ==========================================
export async function autoRedeemPositions() {
    if (isRedeeming) return 0;
    isRedeeming = true;
    let redeemedCount = 0;

    try {
        console.log("🔄 [AUTO-REDEEM] Revisando posiciones marcadas para canjear...");

        const signer = /* clobClient.signer or wallet */; // Debes pasar o importar el signer

        if (!signer) {
            console.error("❌ No se encontró signer para redeem");
            return 0;
        }

        const ctfInterface = new ethers.utils.Interface([
            "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)"
        ]);

        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice 
            ? feeData.gasPrice.mul(130).div(100) 
            : ethers.utils.parseUnits("60", "gwei");

        for (const pos of [...botStatus.activePositions]) {
            const statusLower = (pos.status || "").toLowerCase();
            if (!statusLower.includes("canjear")) continue;
            if (!pos.conditionId) continue;

            try {
                const txData = ctfInterface.encodeFunctionData("redeemPositions", [
                    USDC_ADDRESS,
                    ethers.constants.HashZero,
                    pos.conditionId,
                    [1, 2]
                ]);

                const tx = await signer.sendTransaction({
                    to: CTF_ADDRESS,
                    data: txData,
                    gasLimit: 400000,
                    gasPrice: gasPrice
                });

                await tx.wait(1);

                console.log(`✅ [REDEEM] Canjeado: ${pos.marketName?.substring(0, 50)}...`);
                pos.status = "CANJEADO ✅";
                redeemedCount++;

                await sendAlert(
                    `🔄 *REDEEM EXITOSO*\n\n` +
                    `📋 Mercado: ${pos.marketName?.substring(0, 45)}...\n` +
                    `✅ Canjeado automáticamente\n` +
                    `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
                );

                await new Promise(resolve => setTimeout(resolve, 1500));

            } catch (err) {
                const msg = err.message.toLowerCase();
                if (!msg.includes("not resolved") && !msg.includes("already redeemed")) {
                    console.error(`❌ Redeem falló en ${pos.marketName?.substring(0, 40)}:`, err.message);
                }
            }
        }

        if (redeemedCount > 0) {
            await updateRealBalances();
            saveConfigToDisk("Auto Redeem ejecutado");
            console.log(`🎉 [AUTO-REDEEM] ${redeemedCount} posiciones canjeadas`);
        }

        return redeemedCount;

    } catch (err) {
        console.error("❌ Error general en autoRedeemPositions:", err.message);
        return 0;
    } finally {
        isRedeeming = false;
    }
}

// ==========================================
// REDEEM GASLESS (Relayer)
// ==========================================
export async function autoRedeemPositionsGasless() {
    let redeemedCount = 0;

    try {
        console.log("🔄 [AUTO-REDEEM GASLESS] Iniciando...");

        const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');

        if (!process.env.POLY_API_KEY || !process.env.POLY_SECRET || !process.env.POLY_PASSPHRASE) {
            console.error("❌ Faltan credenciales del Builder Relayer");
            return 0;
        }

        const relayerClient = new RelayClient({
            relayerUrl: "https://relayer-v2.polymarket.com",
            chainId: 137,
            privateKey: process.env.POLY_PRIVATE_KEY || "",
            builderKey: process.env.POLY_API_KEY,
            builderSecret: process.env.POLY_SECRET,
            builderPassphrase: process.env.POLY_PASSPHRASE,
            relayTxType: RelayerTxType.SAFE
        });

        for (const pos of [...botStatus.activePositions]) {
            const statusLower = (pos.status || "").toLowerCase();
            if (!statusLower.includes("canjear")) continue;
            if (!pos.conditionId) continue;

            try {
                const redeemTx = {
                    to: CTF_ADDRESS,
                    data: ethers.utils.defaultAbiCoder.encode(
                        ["address", "bytes32", "bytes32", "uint256[]"],
                        [USDC_ADDRESS, ethers.constants.HashZero, pos.conditionId, [1, 2]]
                    ),
                    value: "0"
                };

                const response = await relayerClient.execute([redeemTx], `Redeem ${pos.marketName?.substring(0, 30) || 'Position'}`);

                if (response && typeof response.wait === 'function') {
                    await response.wait();
                }

                console.log(`✅ [REDEEM GASLESS] Canjeado: ${pos.marketName?.substring(0, 45)}...`);
                pos.status = "CANJEADO ✅";
                redeemedCount++;

                await sendAlert(
                    `🔄 *REDEEM GASLESS EXITOSO*\n\n` +
                    `📋 Mercado: ${pos.marketName?.substring(0, 45)}...\n` +
                    `✅ Canjeado sin pagar gas\n` +
                    `💰 Cartera Total: *$${botStatus.carteraTotal} USDC*`
                );

                await new Promise(resolve => setTimeout(resolve, 1500));

            } catch (err) {
                const msg = err.message.toLowerCase();
                if (!msg.includes("not resolved") && !msg.includes("already redeemed")) {
                    console.error(`❌ Gasless redeem falló:`, err.message);
                }
            }
        }

        if (redeemedCount > 0) {
            await updateRealBalances();
            saveConfigToDisk("Auto Redeem Gasless ejecutado");
            console.log(`🎉 [AUTO-REDEEM GASLESS] ${redeemedCount} posiciones canjeadas sin gas`);
        }

        return redeemedCount;

    } catch (err) {
        console.error("❌ Error en autoRedeemPositionsGasless:", err.message);
        return 0;
    }
}