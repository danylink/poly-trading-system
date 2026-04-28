// engines/ChronosHarvesterEngine.js
import { BaseEngine } from './BaseEngine.js';
import { botStatus } from '../config.js';
import { runChronosHarvester } from './shared/chronosLogic.js'; // ← lo crearemos después

export class ChronosHarvesterEngine extends BaseEngine {
    constructor() {
        super("Chronos Harvester");
        this.enabled = botStatus.chronosEnabled;
    }

    async scan() {
        if (!this.enabled || botStatus.isPanicStopped) return;
        await runChronosHarvester();
    }
}