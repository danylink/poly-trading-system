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

async function scanLiveWhales() {
    console.log("=========================================");
    console.log("🌊 RADAR QUANT DE BALLENAS - CON ÚLTIMA ACTIVIDAD");
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

            if (!whaleStats[address]) {
                whaleStats[address] = {
                    address: address,
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

            // Clasificación rápida por título
            let category = "otros";
            if (/trump|zelensky|ukraine|russia|fed|cpi|election|congress|starmer|warsh|pokrovsk|iran|israel|kevin warsh/.test(title)) {
                category = "politica";
            } else if (/bitcoin|ethereum|solana|dogecoin|crypto|xrp|bnb/.test(title)) {
                category = "crypto";
            } else if (/fed|interest rate|cpi|elon|business|nasdaq|sp500/.test(title)) {
                category = "business";
            }

            if (["politica", "crypto", "business"].includes(category)) {
                whaleStats[address].relevantVolume += volume;
            }
        }

        const whalesArray = Object.values(whaleStats)
            .filter(w => w.totalVolume > 150)
            .filter(w => w.tradeCount > 2)
            .map(w => ({
                ...w,
                relevanceScore: w.totalVolume > 0 ? Math.round((w.relevantVolume / w.totalVolume) * 100) : 0,
                lastActivity: timeAgo(w.lastTimestamp)
            }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore || b.lastTimestamp - a.lastTimestamp);

        console.log(`✅ Escaneo completo → ${whalesArray.length} ballenas candidatas\n`);

        whalesArray.slice(0, 20).forEach((w, i) => {
            const color = w.relevanceScore >= 70 ? "🟢" : (w.relevanceScore >= 50 ? "🟡" : "🔴");
            console.log(`${color} #${i+1} | ${w.address}`);
            console.log(`   Nickame: ${w.name}`);
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