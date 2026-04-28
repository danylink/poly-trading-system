// ==========================================
// index.js - Entry Point Principal (Modular)
// ==========================================

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { setupLogger } from './utils/logger.js';
import { loadConfigFromDisk } from './config.js';
import { initCLOB } from './services/polymarketService.js';
import { startBotLoops } from './bot.js';
import routes from './api/routes.js';
import { memoryLogs } from './utils/logger.js';

dotenv.config();

// ====================== INICIALIZACIÓN ======================
setupLogger();                    // Logger en memoria para dashboard
loadConfigFromDisk();             // Carga bot_config.json

const app = express();
app.use(cors());
app.use(express.json());

// ====================== RUTAS ======================
app.use('/api', routes);

// ====================== HEALTH CHECK ======================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(), 
        memoryMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2)
    });
});

// ====================== ARRANQUE ======================
const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
    console.log(`\n======================================================`);
    console.log(`🎯 POLY-SNIPER V2 - MODULAR EDITION`);
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
    console.log(`======================================================\n`);

    try {
        // 1. Conexión CLOB
        await initCLOB(); 

        // 2. Iniciar todos los loops y engines
        await startBotLoops();

        console.log("✅ Bot completamente inicializado y corriendo.");
        console.log("📡 Dashboard disponible en: http://localhost:" + PORT);
    } catch (error) {
        console.error("❌ Error crítico durante el arranque:", error.message);
        process.exit(1);
    }
});

// Exportar para posibles tests o PM2
export default app;