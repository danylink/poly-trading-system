// services/balanceService.js
import { ethers } from 'ethers';
import { botStatus } from '../config.js';
import { getCurrentPositionValue } from './polymarketService.js';
import { USDC_ADDRESS } from '../constants.js';

const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);

// ==========================================
// 2. ACTUALIZACIÓN DE SALDOS (NATIVA CLOB) - VERSIÓN BLINDADA QUANT
// ==========================================
export async function updateRealBalances() {
    try {
        // 1. Balance de Gas (POL)
        const polBal = await provider.getBalance(wallet.address);
        botStatus.balancePOL = Number(ethers.utils.formatEther(polBal)).toFixed(3);

        // 2. Balance USDC en MetaMask
        const usdcAbi = ["function balanceOf(address) view returns (uint256)"];
        const usdcContract = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider);
        const walletBalRaw = await usdcContract.balanceOf(wallet.address);
        botStatus.walletOnlyUSDC = (parseFloat(ethers.utils.formatUnits(walletBalRaw, 6))).toFixed(2);

        // 3. Balance USDC en Polymarket (CLOB)
        if (clobClient) {
            await clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" });
            const balanceData = await clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" });
            const clobMonto = parseFloat(balanceData.balance || 0) / 1000000;
            botStatus.clobOnlyUSDC = clobMonto.toFixed(2);
            botStatus.balanceUSDC = botStatus.clobOnlyUSDC;
        }

        // 4. Posiciones activas + CANJEAR (FIX FINAL)
        try {
            const userAddress = process.env.POLY_PROXY_ADDRESS || "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";
            
            // 🔥 FIX CRÍTICO 1: Límite a 500 para evitar posiciones invisibles
            const response = await fetch(`https://data-api.polymarket.com/positions?user=${userAddress}&limit=500`);
            const positions = await response.json();
            
            botStatus.activePositions = []; 
            let totalUnclaimed = 0;

            if (Array.isArray(positions) && positions.length > 0) {
                for (const pos of positions) {
                    const size = parseFloat(pos.size || 0);
                    if (size < 0.1) continue; // Ignoramos polvo (dust)

                    const cashPnl = parseFloat(pos.cashPnl || 0);
                    const percentPnl = parseFloat(pos.percentPnl || 0);
                    const valorActual = parseFloat(pos.currentValue || pos.value || 0);

                    const isRedeemable = pos.redeemable === true || pos['canjeable'] === true;

                    // 🔥 CLAVE: Si está lista para canjear, NO la mostramos en activePositions
                    if (isRedeemable) {
                        totalUnclaimed += valorActual;
                        continue;   // ← Ocultamos del dashboard
                    }

                    // Solo agregamos posiciones realmente activas
                    let outcomeVal = "N/A";
                    if (pos.outcome) {
                        outcomeVal = String(pos.outcome).toUpperCase();
                    } else if (pos.assetName && typeof pos.assetName === 'string') {
                        if (pos.assetName.toUpperCase().includes("-YES")) outcomeVal = "YES";
                        else if (pos.assetName.toUpperCase().includes("-NO")) outcomeVal = "NO";
                    }

                    const currentTokenId = pos.asset || pos.token_id || pos.asset_id;

                    // 🔥 FIX CRÍTICO 2: Extracción Directa desde la API para precisión matemática total
                    const invested = pos.initialValue ? parseFloat(pos.initialValue) : Math.max(0, valorActual - cashPnl);
                    const entryPrice = pos.avgPrice ? parseFloat(pos.avgPrice) : (size > 0 ? (invested / size) : 0);

                    // Recuperar datos de origen (Ballena o Engine)
                    const whaleData = botStatus.copiedPositions?.find(p => p.tokenId === currentTokenId);
                    const savedEngine = botStatus.positionEngines?.[currentTokenId] || null;

                    let finalEngine = savedEngine;
                    let finalNickname = null;

                    if (whaleData && whaleData.nickname) {
                        finalNickname = whaleData.nickname;
                        finalEngine = null;           // ← Importante: null para que no entre en IA badge
                    }

                    botStatus.activePositions.push({
                        tokenId: currentTokenId,
                        conditionId: pos.conditionId || pos.condition_id,
                        size: size.toFixed(2),
                        exactSize: size,
                        marketName: pos.title || pos.market || "Mercado Desconocido",
                        status: "ACTIVO 🟢",
                        currentValue: valorActual.toFixed(2),
                        cashPnl: cashPnl,
                        percentPnl: percentPnl,
                        category: getMarketCategoryEnhanced(pos.title || pos.market || ""),
                        outcome: outcomeVal,
                        engine: finalEngine, 
                        sizeCopied: invested, // <-- RESTAURA VISUALMENTE LA INVERSIÓN (Con precisión absoluta)
                        priceEntry: entryPrice, // <-- RESTAURA VISUALMENTE EL PRECIO (Con precisión absoluta)
                        nickname: finalNickname
                    });
                }
            }
            
            botStatus.unclaimedUSDC = totalUnclaimed.toFixed(2);

            // LIMPIEZA AUTOMÁTICA de copiedTrades
            await cleanupCopiedTrades();

        } catch (apiError) {
            console.log("⚠️ Error al obtener posiciones:", apiError.message);
        }

        // Log de balances
        if (Math.random() < 0.25) {
            const metaMaskVal = parseFloat(botStatus.walletOnlyUSDC || 0);
            const polyVal = parseFloat(botStatus.clobOnlyUSDC || 0);
            const unclaimedVal = parseFloat(botStatus.unclaimedUSDC || 0);
            const activePosValue = botStatus.activePositions.reduce((acc, p) => acc + parseFloat(p.currentValue || 0), 0);
            const carteraTotalReal = (metaMaskVal + polyVal + activePosValue + unclaimedVal).toFixed(2);

            console.log(`📊 Balances: Cartera Total: $${carteraTotalReal} | Disponible (Poly): $${polyVal.toFixed(2)} | MetaMask: $${metaMaskVal.toFixed(2)} | Gas: ${botStatus.balancePOL} POL`);
        }

    } catch (e) { 
        console.error("❌ Error general actualizando balances:", e.message); 
    }

    updateCarteraTotal();
}

// ==========================================
// CALCULAR CARTERA TOTAL COMPLETA (VERSIÓN OFICIAL)
// ==========================================
export function updateCarteraTotal() {
    const poly = parseFloat(botStatus.clobOnlyUSDC || 0);
    const meta = parseFloat(botStatus.walletOnlyUSDC || 0);
    const unclaimed = parseFloat(botStatus.unclaimedUSDC || 0);

    // Valor de posiciones activas
    let activeValue = 0;
    if (botStatus.activePositions && botStatus.activePositions.length > 0) {
        activeValue = botStatus.activePositions.reduce((acc, pos) => {
            if (pos.status && (pos.status.includes('CANJEAR') || pos.status.includes('PERDIDO'))) {
                return acc;
            }
            return acc + parseFloat(pos.currentValue || 0);
        }, 0);
    }

    const total = poly + meta + unclaimed + activeValue;
    botStatus.carteraTotal = total.toFixed(2);

    return botStatus.carteraTotal;
}