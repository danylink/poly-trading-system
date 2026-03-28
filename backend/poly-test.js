import { ClobClient, Chain, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

// Use the fresh keys extracted from the error response
const creds = {
    key: "467d4a97-eac5-6153-85f0-d6d2bfac4f6f",
    secret: "PLopmrvvIyukOgMwAkp2Tz1CJ5wkLPc4JodGG6bIcSQ=",
    passphrase: "1aeb79dcf18a2fbcdb84ea50b6a0b2cef4352eabda4f606ee645c41b097afc6d"
};

const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, creds);

async function testFreshKey() {
    try {
        const realTokenID = "75467129615908319583031474642658885479135630431889036121812713428992454630178";
        console.log("Probando llave fresca con TokenID real...");
        const order = await clobClient.createOrder({
            tokenID: realTokenID,
            price: 0.004,
            side: Side.BUY,
            size: 10,
            feeRateBps: 0
        });
        const response = await clobClient.postOrder(order);
        console.log("✅ RESPUESTA CLOB:", JSON.stringify(response));
    } catch (e) {
        console.error("❌ FALLO:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}
testFreshKey();
