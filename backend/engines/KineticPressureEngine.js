// engines/KineticPressureEngine.js
import { BaseEngine } from './BaseEngine.js';
import { botStatus } from '../config.js';
import { runKineticPressureScanner } from './shared/kineticLogic.js'; // ← lo crearemos después

export class KineticPressureEngine extends BaseEngine {
    constructor() {
        super("Kinetic Pressure");
        this.enabled = botStatus.kineticEnabled;
    }

    async scan() {
        if (!this.enabled || botStatus.isPanicStopped) return;
        await runKineticPressureScanner();
    }
}