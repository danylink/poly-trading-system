async function getActiveMarkets() {
    console.log("--- Cargando mercados activos de Polymarket ---");
    
    // URL de la API de Gamma para mercados activos que no han cerrado
    const url = "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=15";

    try {
        const response = await fetch(url);
        const markets = await response.json();

        markets.forEach((m, index) => {
            // clobTokenIds es un array donde: [0] es el ID para YES, [1] es el ID para NO
            const tokenIds = JSON.parse(m.clobTokenIds);
            
            console.log(`${index + 1}. PREGUNTA: ${m.question}`);
            console.log(`   > YES Token ID: ${tokenIds[0]}`);
            console.log(`   > NO  Token ID: ${tokenIds[1]}`);
            console.log(`   > Liquidez: $${Math.round(m.liquidity)} USD`);
            console.log("-----------------------------------------------");
        });
    } catch (error) {
        console.error("Error al obtener los mercados:", error);
    }
}

getActiveMarkets();
