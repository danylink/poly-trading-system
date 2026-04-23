import fs from 'fs';
import axios from 'axios';

// 👇 CAMBIA ESTO por el nombre exacto de tu archivo de memoria/configuración
// Puede ser 'botStatus.json', 'config.json', 'state.json', etc.
const ARCHIVO_CONFIG = './bot_config.json'; 

const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json'
};

const delay = ms => new Promise(res => setTimeout(res, ms));

function isShortTermMarket(title) {
    const t = (title || "").toLowerCase();
    return /up or down|above .* on|by .* [0-9]+:[0-9]+|15m|5m|10m|minute|temperature|weather|°c|°f/.test(t);
}

function isLongTermMarket(title) {
    const t = (title || "").toLowerCase();
    return /by april|by may|by june|by july|by 2026|2026|trump say|zelensky|ukraine|russia|fed|cpi|election|congress|starmer|warsh|pokrovsk|iran|israel|nasdaq|sp500|interest rate|elon|tesla/.test(t);
}

async function pruneEliteWhales() {
    console.log("=========================================");
    console.log("💼 AUDITORÍA QUANT: RECORTE DE PLANTILLA");
    console.log("=========================================\n");

    // 1. Leer el archivo de configuración
    let config;
    try {
        const rawData = fs.readFileSync(ARCHIVO_CONFIG, 'utf8');
        config = JSON.parse(rawData);
    } catch (e) {
        console.error(`❌ Error leyendo ${ARCHIVO_CONFIG}. Verifica el nombre del archivo.`);
        return;
    }

    let whales = config.customWhales || [];
    if (whales.length <= 15) {
        console.log(`✅ Tienes ${whales.length} ballenas. No es necesario recortar.`);
        return;
    }

    console.log(`📊 Analizando a ${whales.length} ballenas empleadas... Esto tomará un minuto para no saturar la API.\n`);

    let evaluatedWhales = [];

    // 2. Analizar a cada ballena individualmente
    for (let i = 0; i < whales.length; i++) {
        const whale = whales[i];
        process.stdout.write(`🕵️‍♂️ Auditando [${i + 1}/${whales.length}]: ${whale.nickname || whale.address.substring(0,8)}... `);

        try {
            const res = await axios.get(`https://data-api.polymarket.com/trades?user=${whale.address}&limit=50`, { headers, timeout: 10000 });
            const trades = Array.isArray(res.data) ? res.data : (res.data.data || []);

            let totalVol = 0;
            let macroVol = 0;
            let trashVol = 0;

            trades.forEach(t => {
                const vol = (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
                const title = t.title || "";
                
                totalVol += vol;
                
                if (isShortTermMarket(title)) {
                    trashVol += vol;
                } else if (isLongTermMarket(title)) {
                    macroVol += vol;
                }
            });

            // Castigos y Premios
            const isZombie = trades.length === 0;
            const macroScore = totalVol > 0 ? (macroVol / totalVol) * 100 : 0;
            const penalty = trashVol > macroVol ? 50 : 0; // Castigo duro por operar basura

            const finalScore = macroScore - penalty;

            evaluatedWhales.push({
                originalData: whale,
                score: finalScore,
                totalVol: totalVol,
                isZombie: isZombie
            });

            if (isZombie) console.log("🧟‍♂️ ZOMBIE DETECTADO");
            else console.log(`Score: ${finalScore.toFixed(0)} | Vol: $${totalVol.toFixed(0)}`);

        } catch (error) {
            console.log(`❌ Error de API (Rate limit). Se le asignará score 0.`);
            evaluatedWhales.push({ originalData: whale, score: -100, totalVol: 0, isZombie: true });
        }

        // Retardo Quant para evitar ban de IP (Rate Limit 429)
        await delay(400); 
    }

    // 3. Ordenar y ejecutar el despido masivo
    console.log("\n=========================================");
    console.log("🏆 SELECCIONANDO A LA MESA DIRECTIVA (TOP 15)");
    console.log("=========================================\n");

    // Ordenar: Primero por mayor Score Macro, luego por mayor Volumen en caso de empate
    evaluatedWhales.sort((a, b) => b.score - a.score || b.totalVol - a.totalVol);

    // Filtrar a los peores y quedarnos con los 15 mejores (que no sean zombies)
    const elite15 = evaluatedWhales
        .filter(w => !w.isZombie && w.score > 0)
        .slice(0, 15);

    elite15.forEach((w, index) => {
        console.log(`🥇 #${index + 1} | ${w.originalData.nickname || w.originalData.address.substring(0,8)} | Score: ${w.score.toFixed(0)}`);
    });

    // 4. Guardar los cambios
    config.customWhales = elite15.map(w => w.originalData);
    
    fs.writeFileSync(ARCHIVO_CONFIG, JSON.stringify(config, null, 4));
    
    console.log(`\n💾 ¡Operación exitosa! Tu archivo de configuración ha sido limpiado.`);
    console.log(`📉 Plantilla reducida de ${whales.length} a ${elite15.length} ballenas Élite.`);
    console.log(`🚀 Ya puedes reiniciar el bot con: pm2 start poly-bot`);
}

pruneEliteWhales();