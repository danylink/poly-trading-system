// approve-ctf-erc1155.mjs — setApprovalForAll para los exchanges de Polymarket
import { ClobClient, Chain } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

// Dirección oficial del CTF ERC-1155 de Polymarket en Polygon
// Fuente: https://docs.polymarket.com y polygonscan.com
const CTF_CONTRACT   = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Tokens ERC-1155
const CTF_EXCHANGE   = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCH  = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPT = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const ERC1155_ABI = [
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address account, address operator) view returns (bool)'
];
const ctf = new ethers.Contract(CTF_CONTRACT, ERC1155_ABI, wallet);

const gasOptions = {
    maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
    maxFeePerGas: ethers.utils.parseUnits("150", "gwei")
};

console.log('=== setApprovalForAll en CTF ERC-1155 ===');
console.log('Wallet:', wallet.address);
console.log('CTF Contract:', CTF_CONTRACT);

for (const [name, addr] of [
    ['CTF Exchange', CTF_EXCHANGE],
    ['NegRisk Exchange', NEG_RISK_EXCH],
    ['NegRisk Adapter', NEG_RISK_ADAPT],
]) {
    const approved = await ctf.isApprovedForAll(wallet.address, addr);
    if (!approved) {
        console.log(`🔓 Aprobando ERC-1155 → ${name} (${addr})...`);
        const tx = await ctf.setApprovalForAll(addr, true, gasOptions);
        console.log(`   Hash: ${tx.hash}`);
        await tx.wait();
        console.log(`✅ Aprobado: ${name}`);
    } else {
        console.log(`✅ ${name}: ya aprobado`);
    }
}

// Verificar resultado en el CLOB
console.log('\n=== VERIFICACIÓN EN EL CLOB ===');
const tempClob = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet);
const creds = await tempClob.deriveApiKey();
const clobClient = new ClobClient('https://clob.polymarket.com', Chain.POLYGON, wallet, creds, 0);

const TOKEN_ID = "24394670903706558879845790079760859552309100903651562795058188175118941818512";
const result = await clobClient.getBalanceAllowance({ 
    asset_type: 'CONDITIONAL',
    token_id: TOKEN_ID
});
console.log("Estado CLOB:", JSON.stringify(result, null, 2));
