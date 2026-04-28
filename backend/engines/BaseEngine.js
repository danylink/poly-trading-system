// engines/BaseEngine.js
export class BaseEngine {
    constructor(name) {
        this.name = name;
        this.enabled = false;
    }

    async scan() {
        throw new Error(`scan() no implementado en ${this.name}`);
    }

    async execute(market) {
        throw new Error(`execute() no implementado en ${this.name}`);
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }
}