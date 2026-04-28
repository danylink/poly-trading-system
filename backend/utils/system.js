// utils/system.js
import os from 'os';
import { botStatus } from '../config.js';
import { sendAlert } from '../services/telegramService.js';

let lastHealthAlertTime = 0;

export async function monitorSystemHealth() {
    try {
        const now = Date.now();
        const botRamMB = process.memoryUsage().rss / 1024 / 1024;
        const cpuLoad = os.loadavg()[0];

        if (botRamMB > 700 && now - lastHealthAlertTime > 3600000) {
            await sendAlert(`⚠️ *ALERTA DE MEMORIA*\nBot usando *${botRamMB.toFixed(0)} MB* de RAM.`);
            lastHealthAlertTime = now;
        }
    } catch (e) {}
}