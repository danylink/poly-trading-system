// services/whaleService.js
import { botStatus } from '../config.js';
import axios from 'axios';

// ==========================================
// AUTO COPY-TRADING - SELECCIÓN AUTOMÁTICA DE WHALES
// ==========================================
export async function autoSelectTopWhales() {
    if (!botStatus.copyTradingAutoEnabled) return;   // ← Solo se ejecuta si el Auto está ON

    console.log(`🔍 [AUTO-WHALE] Seleccionando las mejores ballenas automáticamente...`);
    

    try {
        const response = await axios.get(
            'https://data-api.polymarket.com/v1/leaderboard?timePeriod=WEEK&orderBy=PNL&limit=50',
            { httpsAgent: agent, timeout: 10000 }
        );

        const traders = response.data || [];

        const goodWhales = traders
            .filter(t => {
                const address = t.proxyWallet;
                const pnl = parseFloat(t.pnl || 0);
                const volume = parseFloat(t.vol || 0);

                return address && 
                       address.startsWith('0x') &&
                       pnl > 500000 && 
                       volume > 500000;
            })
            .sort((a, b) => parseFloat(b.pnl || 0) - parseFloat(a.pnl || 0))
            .slice(0, botStatus.maxWhalesToCopy || 5);

        botStatus.autoSelectedWhales = goodWhales.map(t => ({
            address: t.proxyWallet,
            pnl: parseFloat(t.pnl || 0),
            winRate: 0.55,
            volume: parseFloat(t.vol || 0)
        }));

        botStatus.lastWhaleSelection = new Date().toLocaleTimeString();

        console.log(`✅ [AUTO-WHALE] Seleccionadas ${botStatus.autoSelectedWhales.length} ballenas completas:`);
        botStatus.autoSelectedWhales.forEach((w, i) => {
            console.log(`   ${i+1}. ${w.address} | PnL: $${w.pnl.toLocaleString()} | Vol: $${w.volume.toLocaleString()}`);
        });

    } catch (error) {
        console.error("❌ Error consultando leaderboard:", error.message);
    }
}

export async function runWhaleRadar() {
    if (whaleRadarCache.isScanning) return;
    whaleRadarCache.isScanning = true;

    try {
        console.log("🌊 [RADAR] Iniciando escaneo profundo de ballenas macro...");
        const tradeRes = await axios.get('https://data-api.polymarket.com/trades?limit=1000', {
            httpsAgent: agent,
            timeout: 15000
        });

        let trades = Array.isArray(tradeRes.data) ? tradeRes.data : (tradeRes.data.data || []);
        const whaleStats = {};

        for (const trade of trades) {
            const address = trade.proxyWallet || trade.maker_address || trade.user;
            if (!address) continue;

            const volume = (parseFloat(trade.size) || 0) * (parseFloat(trade.price) || 0);
            const title = (trade.title || "").toLowerCase();
            const ts = trade.timestamp || 0;
            const nickname = trade.pseudonym || trade.name || address.substring(0, 5);

            if (!whaleStats[address]) {
                whaleStats[address] = {
                    address, nickname, totalVolume: 0, relevantVolume: 0,
                    tradeCount: 0, markets: new Set(), lastTimestamp: 0
                };
            }

            whaleStats[address].totalVolume += volume;
            whaleStats[address].tradeCount += 1;
            if (trade.conditionId || title) whaleStats[address].markets.add(trade.conditionId || title);
            if (ts > whaleStats[address].lastTimestamp) whaleStats[address].lastTimestamp = ts;

            const isShort = isShortTermMarket(title);
            const isLong = isLongTermMarket(title);

            if (!isShort && isLong) {
                whaleStats[address].relevantVolume += volume;
            }
        }

        const whalesArray = Object.values(whaleStats)
            .filter(w => w.totalVolume > 100 && w.tradeCount > 2)
            .map(w => {
                const relevance = w.totalVolume > 0 ? Math.round((w.relevantVolume / w.totalVolume) * 100) : 0;
                
                // Sistema de Estrellas/Recomendación tipo Quant
                let stars = 0;
                let rec = "No recomendado";
                if (relevance >= 80 && w.relevantVolume > 500) { stars = 5; rec = "TOP MACRO"; }
                else if (relevance >= 60) { stars = 4; rec = "Excelente"; }
                else if (relevance >= 40) { stars = 3; rec = "Aceptable"; }
                else if (relevance >= 20 && w.totalVolume > 2000) { stars = 2; rec = "Volumen Mixto"; }
                else if (relevance > 0) { stars = 1; rec = "Baja Relevancia"; }

                return {
                    address: w.address,
                    nickname: w.nickname,
                    totalVolume: w.totalVolume,
                    relevantVolume: w.relevantVolume,
                    relevanceScore: relevance,
                    tradeCount: w.tradeCount,
                    marketCount: w.markets.size,
                    lastActivity: timeAgo(w.lastTimestamp),
                    stars,
                    recommendation: rec,
                    rawTimestamp: w.lastTimestamp
                };
            })
            .sort((a, b) => b.relevanceScore - a.relevanceScore || b.totalVolume - a.totalVolume)
            .slice(0, 15); // Guardamos el Top 15

        whaleRadarCache.whales = whalesArray;
        whaleRadarCache.lastScan = new Date().toLocaleTimeString();

        // 🔥 LA MAGIA: Ejecutamos el administrador de nómina
        manageWhaleRoster(whalesArray);

        console.log(`✅ [RADAR] Escaneo completo. Top 1 detectado: ${whalesArray[0]?.nickname || 'N/A'}`);

    } catch (error) {
        console.error("❌ [RADAR] Error escaneando:", error.message);
    } finally {
        whaleRadarCache.isScanning = false;
    }
}

// ==========================================
// 🏢 RECURSOS HUMANOS QUANT (Auto-Gestión y Meritocracia)
// ==========================================
export function manageWhaleRoster(radarWhales) {
    if (!botStatus.copyTradingCustomEnabled) return;

    const now = Date.now();
    let removedZombies = 0;
    let addedTopWhales = 0;
    
    // 🔥 FIX QUANT: Reemplazamos el 15 fijo por tu variable dinámica del Dashboard
    // Si por alguna razón no llega, usa 15 como red de seguridad.
    const MAX_WHALE_ROSTER = botStatus.autoWhaleCount || 15;

    // 1. DESPEDIR ZOMBIES ABSOLUTOS (Más de 15 días inactivos)
    botStatus.customWhales = botStatus.customWhales.filter(whale => {
        if (whale.lastActive) {
            const diffDays = (now - whale.lastActive) / (1000 * 60 * 60 * 24);
            if (diffDays > 15) {
                console.log(`🧟‍♂️ [AUTO-CLEAN] Eliminando ballena Zombie (Ausente > 15 días): ${whale.nickname || whale.address}`);
                removedZombies++;
                return false; 
            }
        }
        return true; 
    });

    // 2. CONTRATAR TALENTO FRESCO Y GESTIONAR MERITOCRACIA
    for (const rw of radarWhales) {
        if (rw.stars >= 4) {
            const exists = botStatus.customWhales.some(w => w.address.toLowerCase() === rw.address.toLowerCase());
            
            if (!exists) {
                // ESCENARIO A: Hay espacio en la plantilla
                if (botStatus.customWhales.length < MAX_WHALE_ROSTER) {
                    botStatus.customWhales.push({
                        address: rw.address.toLowerCase(),
                        nickname: rw.nickname || "Auto-Quant",
                        enabled: true,
                        lastActive: rw.rawTimestamp ? rw.rawTimestamp * 1000 : Date.now()
                    });
                    console.log(`🌟 [AUTO-HIRE] Nueva ballena agregada: ${rw.nickname || rw.address}`);
                    addedTopWhales++;
                } 
                // ESCENARIO B: Plantilla llena, pero el candidato es un TOP MACRO (5 Estrellas)
                else if (rw.stars === 5) {
                    const sortedWhales = [...botStatus.customWhales].sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));
                    const peorEmpleado = sortedWhales[0];
                    const diasInactivo = (now - (peorEmpleado.lastActive || 0)) / (1000 * 60 * 60 * 24);

                    // 🔥 FIX QUANT: Tolerancia Macro. Un francotirador puede no operar en una semana.
                    // Solo hacemos el intercambio si nuestro peor empleado lleva más de 7 días dormido.
                    if (diasInactivo >= 7) {
                        console.log(`🔀 [MERITOCRACIA] Despidiendo a ${peorEmpleado.nickname || peorEmpleado.address.substring(0,8)} (Inactivo ${Math.floor(diasInactivo)} días) para contratar a la superestrella ${rw.nickname || rw.address}`);
                        
                        botStatus.customWhales = botStatus.customWhales.filter(w => w.address !== peorEmpleado.address);
                        
                        botStatus.customWhales.push({
                            address: rw.address.toLowerCase(),
                            nickname: rw.nickname || "Auto-Quant",
                            enabled: true,
                            lastActive: rw.rawTimestamp ? rw.rawTimestamp * 1000 : Date.now()
                        });
                        addedTopWhales++;
                    }
                }
            }
        }
    }

    if (removedZombies > 0 || addedTopWhales > 0) {
        saveConfigToDisk("Auto-Gestión de Ballenas (RRHH)");
    }
}