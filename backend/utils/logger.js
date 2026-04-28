// utils/logger.js
const memoryLogs = [];
const MAX_LOGS = 100;

export function setupLogger() {
    const originalLog = console.log;
    const originalError = console.error;

    console.log = function(...args) {
        originalLog.apply(console, args);
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
        memoryLogs.push({ 
            time: new Date().toLocaleTimeString(), 
            type: 'info', 
            message 
        });
        if (memoryLogs.length > MAX_LOGS) memoryLogs.shift();
    };

    console.error = function(...args) {
        originalError.apply(console, args);
        const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
        memoryLogs.push({ 
            time: new Date().toLocaleTimeString(), 
            type: 'error', 
            message 
        });
        if (memoryLogs.length > MAX_LOGS) memoryLogs.shift();
    };
}

export { memoryLogs };