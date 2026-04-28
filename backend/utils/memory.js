// utils/memory.js
export const priceHistoryCache = {};
export const closedPositionsCache = new Set();
export const pendingOrdersCache = new Set();
export const analysisCache = new Map();

export function recordPriceToMemory(tokenId, currentPrice) {
    if (!tokenId || !currentPrice) return;

    const now = Date.now();
    const price = parseFloat(currentPrice);

    if (!priceHistoryCache[tokenId]) priceHistoryCache[tokenId] = [];

    priceHistoryCache[tokenId].push({ timestamp: now, price });

    // Mantener solo últimos 8 puntos
    if (priceHistoryCache[tokenId].length > 8) {
        priceHistoryCache[tokenId].shift();
    }
}