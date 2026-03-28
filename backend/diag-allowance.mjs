import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { createRequire } from 'module';
dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
const wallet = new ethers.Wallet(process.env.POLY_PRIVATE_KEY.trim(), provider);

const USDC_NATIVE       = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER  = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns(uint256)'
];

async function main() {
    const usdc = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);

    const [pol, usdcBal, allowCTF, allowNegRisk, allowAdapter] = await Promise.all([
        provider.getBalance(wallet.address),
        usdc.balanceOf(wallet.address),
        usdc.allowance(wallet.address, CTF_EXCHANGE),
        usdc.allowance(wallet.address, NEG_RISK_EXCHANGE),
        usdc.allowance(wallet.address, NEG_RISK_ADAPTER),
    ]);

    console.log('=== DIAGNÓSTICO DE WALLET ===');
    console.log('Wallet:', wallet.address);
    console.log('POL (gas):', ethers.utils.formatEther(pol));
    console.log('');
    console.log('=== USDC NATIVO (0x3c49...) ===');
    console.log('Balance:', ethers.utils.formatUnits(usdcBal, 6), 'USDC');
    console.log('');
    console.log('=== ALLOWANCES ===');
    console.log('CTF Exchange      (0x4bFb...):', ethers.utils.formatUnits(allowCTF, 6), allowCTF.gt(0) ? '✅' : '❌ FALTA APROBACIÓN');
    console.log('NegRisk Exchange  (0xC5d5...):', ethers.utils.formatUnits(allowNegRisk, 6), allowNegRisk.gt(0) ? '✅' : '❌ FALTA APROBACIÓN');
    console.log('NegRisk Adapter   (0xd91E...):', ethers.utils.formatUnits(allowAdapter, 6), allowAdapter.gt(0) ? '✅' : '❌ FALTA APROBACIÓN');

    // El mercado Ukraine/Russia es un mercado NegRisk
    const needed = ethers.utils.parseUnits('3.34', 6);
    if (usdcBal.lt(needed)) {
        console.log('\n❌ PROBLEMA: Balance USDC insuficiente:', ethers.utils.formatUnits(usdcBal, 6), 'USDC (se necesitan ~3.34)');
    } else {
        console.log('\n✅ Balance USDC suficiente');
    }

    if (allowNegRisk.eq(0)) {
        console.log('⚠️  CAUSA PROBABLE: Este mercado usa NegRisk Exchange y NO tiene allowance!');
    }
}

main().catch(console.error);
