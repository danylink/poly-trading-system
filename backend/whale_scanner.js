import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://polymarket.com/'
};

function timeAgo(timestamp) {
    if (!timestamp) return "Desconocido";
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return "hace unos segundos";
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} minutos`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} horas`;
    return `hace ${Math.floor(diff / 86400)} días`;
}

// Excluye SOLO mercados ultra-cortos (5-15 minutos)
function isShortTermMarket(title) {
    const t = (title || "").toLowerCase();
    return /up or down|above .* on|by .* [0-9]+:[0-9]+|3:.*pm-4:.*pm|4:.*pm-5:.*pm|15m|5m|10m|minute|minutos/.test(t);
}

// Detecta mercados de LARGO PLAZO (mucho más amplio)
function isLongTermMarket(title) {
    const t = (title || "").toLowerCase();
    return /by april|by may|by june|by july|by 2026|2026|trump say|zelensky|ukraine|russia|fed|cpi|election|congress|starmer|warsh|pokrovsk|iran|israel|kevin warsh|nasdaq|sp500|interest rate|elon|tesla|spacex|munich|sao paulo|temperature|will there be|will trump|will russia|will bitcoin|will ethereum/.test(t);
}

async function scanLiveWhales() {
    console.log("=========================================");
    console.log("🌊 RADAR QUANT DE BALLENAS - FILTRO MEJORADO LARGO PLAZO");
    console.log("=========================================\n");

    try {
        const tradeRes = await axios.get('https://data-api.polymarket.com/trades?limit=1000', {
            headers,
            httpsAgent,
            timeout: 15000
        });

        let trades = tradeRes.data;
        if (!Array.isArray(trades) && trades.data) trades = trades.data;

        console.log(`✅ Procesando ${trades.length} trades...\n`);

        const whaleStats = {};

        for (const trade of trades) {
            const address = trade.proxyWallet;
            if (!address) continue;

            const volume = (parseFloat(trade.size) || 0) * (parseFloat(trade.price) || 0);
            const title = (trade.title || "").toLowerCase();
            const ts = trade.timestamp || 0;

            const nickname = trade.pseudonym || trade.name || address.substring(0, 5);

            if (!whaleStats[address]) {
                whaleStats[address] = {
                    address: address,
                    nickname: nickname,
                    totalVolume: 0,
                    relevantVolume: 0,
                    tradeCount: 0,
                    markets: new Set(),
                    lastTimestamp: 0
                };
            }

            whaleStats[address].totalVolume += volume;
            whaleStats[address].tradeCount += 1;
            whaleStats[address].markets.add(trade.conditionId || title);

            if (ts > whaleStats[address].lastTimestamp) {
                whaleStats[address].lastTimestamp = ts;
            }

            const isShort = isShortTermMarket(trade.title || "");
            const isLong = isLongTermMarket(trade.title || "");

            // Solo cuenta como relevante si NO es ultra-corto Y es largo plazo
            if (!isShort && isLong) {
                whaleStats[address].relevantVolume += volume;
            }
        }

        const whalesArray = Object.values(whaleStats)
            .filter(w => w.totalVolume > 100)
            .filter(w => w.tradeCount > 2)
            .map(w => ({
                ...w,
                relevanceScore: w.totalVolume > 0 ? Math.round((w.relevantVolume / w.totalVolume) * 100) : 0,
                lastActivity: timeAgo(w.lastTimestamp)
            }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore || b.lastTimestamp - a.lastTimestamp);

        console.log(`✅ Escaneo completo → ${whalesArray.length} ballenas candidatas\n`);

        whalesArray.slice(0, 20).forEach((w, i) => {
            const color = w.relevanceScore >= 70 ? "🟢" : (w.relevanceScore >= 40 ? "🟡" : "🔴");
            console.log(`${color} #${i+1} | ${w.address}`);
            console.log(`   Nickname: ${w.nickname}`);
            console.log(`   Volumen total: $${w.totalVolume.toFixed(0)}`);
            console.log(`   Volumen relevante: $${w.relevantVolume.toFixed(0)} (${w.relevanceScore}%)`);
            console.log(`   Operaciones: ${w.tradeCount} | Mercados: ${w.markets.size}`);
            console.log(`   Última actividad: ${w.lastActivity}\n`);
        });

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

scanLiveWhales();