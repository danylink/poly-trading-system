// engines/QuantumEqualizerEngine.js
import { BaseEngine } from './BaseEngine.js';
import { botStatus } from '../config.js';
import { checkForLiquidityShocks } from '../utils/memory.js';
import { verifyShockWithIA } from './shared/verifyShock.js'; // ← lo crearemos después

export class QuantumEqualizerEngine extends BaseEngine {
    constructor() {
        super("Quantum Equalizer");
        this.enabled = botStatus.equalizerEnabled;
    }

    async scan() {
        if (!this.enabled || botStatus.isPanicStopped) return;
        await checkForLiquidityShocks();
    }
}