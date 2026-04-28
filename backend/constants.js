// ==========================================
// constants.js - Constantes Centralizadas
// ==========================================

export const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const CTF_ADDRESS = "0x4BFb304598296E5105583dA39cE9dcFD29944545";
export const PROXY_WALLET = "0x876E00CBF5c4fe22F4FA263F4cb713650cB758d2";

export const CONFIG_FILE = path.join(process.cwd(), 'bot_config.json');
export const MEXICO_TZ = 'America/Mexico_City';

export const DEFAULT_SETTINGS = {
    maxCopyMarketsCustom: 10,
    maxCopyDaysForWhales: 15,
    maxCopyMarketsPerWhale: 1,
    autoWhaleCount: 15,
    copyMinWhaleSize: 150,
    copyTimeWindowMinutes: 45,
    aiReserveAmount: 50,
    dailyLossLimit: 15,
    equalizerShockThreshold: 15,
    equalizerBetAmount: 5,
    chronosBetAmount: 5,
    chronosMinPrice: 0.55,
    chronosMaxPrice: 0.92,
    chronosHoursLeft: 168,
    kineticBetAmount: 10,
    kineticImbalanceRatio: 8,
    kineticDepthPercent: 2,
    kineticMaxPositions: 3,
    equalizerTpThreshold: 15,
    chronosTpThreshold: 20,
    kineticTpThreshold: 10,
    whalePostPartialTp: 80,
};

// Configuración de APIs
export const API_ENDPOINTS = {
    GAMMA_MARKETS: 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=1000&order=volume&dir=desc',
    CLOB_BASE: 'https://clob.polymarket.com',
    DATA_API: 'https://data-api.polymarket.com',
};

// Time windows (en milisegundos)
export const TIME_WINDOWS = {
    SHORT_TERM: 96 * 60 * 60 * 1000,      // 4 días para IA
    COPY_MAX: 15 * 24 * 60 * 60 * 1000,  // 15 días para ballenas
    COOLDOWN: 60 * 60 * 1000,            // 60 minutos cooldown por defecto
};

export default {
    USDC_ADDRESS,
    CTF_ADDRESS,
    PROXY_WALLET,
    CONFIG_FILE,
    MEXICO_TZ,
    DEFAULT_SETTINGS,
    API_ENDPOINTS,
    TIME_WINDOWS
};