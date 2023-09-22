// Description: Dump info from a list of tokens using TokenTools.sol
const { ethers } = require('ethers');

const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    PRIVATE_KEY,
    TRADE_CONTRACT_ABI,
    TOKEN_TOOLS_ABI,
    TRADE_CONTRACT_ADDRESS,
    SAFE_TOKENS,
} = require('./constants');
const { logger, blacklistTokens } = require('./constants');
const { loadAllPoolsFromV2, loadAllPoolsFromV3, keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools, preSelectPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools } = require('./utils');
const { exactTokensOut, computeProfit, optimizeAmountIn } = require('./simulator');
const tokens = require('./tokens');
const fs = require('fs');

// Use in combination with a local forked node synced at the target block:
// anvil --fork-url https://polygon-mainnet.g.alchemy.com/v2/xxx --fork-block-number 47726042

async function dumpTokens() {
    // Send arbitrage transaction
    console.log("Dumping token info...");

    // Use local anvil node
    const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");

    // Local deployment
    const TOKEN_TOOLS_ADDRESS = "0x1447bf96F64FB8b27b9DCdFE71a1F47899eFBE10"

    // Create a signer
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const account = signer.connect(provider);
    const tokenTools = new ethers.Contract(TOKEN_TOOLS_ADDRESS, TOKEN_TOOLS_ABI, account);

    const tokens = [
        '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // USDT
        '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC
        '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', // DAI
        '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // WETH
    ];
    const wmatic = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' // WMATIC

    // Make an eth_call to the tokenTools contract to get the token info
    const tokenInfo = await tokenTools.getTokenInfo(tokens);
    console.log("Token info: ", tokenInfo);

    // Use the V2 factory contract to find pools involving each token and wmatic
    const V2FactoryAbi = require('../abi/UniswapV2Factory.json');
    // const pools = [];
    // // QuickSwap factory
    // const factory = new ethers.Contract("0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32", V2FactoryAbi, provider);
    // for (const token of tokens) {
    //     const poolAddress = await factory.getPair(token, "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270");
    //     pools.push(poolAddress);
    // }

    const pools = [
        "0x604229c960e5CACF2aaEAc8Be68Ac07BA9dF81c3", // WMATIC-USDT
        "0x6e7a5FAFcec6BB1e78bAE2A1F0B612012BF14827", // WMATIC-USDC
        "0xEEf611894CeaE652979C9D0DaE1dEb597790C6eE", // WMATIC-DAI
        "0xadbF1854e5883eB8aa7BAf50705338739e558E5b"  // WMATIC-WETH
    ];
    console.log("Pools: ", pools);

    // Make an eth_call to the tokenTools contract to get the pool info
    const testResult = await tokenTools.trySwapTransfer(
        ["0xc2132D05D31c914a87C6611C10748AEb04B58e8F"], // USDT
        ["0x604229c960e5CACF2aaEAc8Be68Ac07BA9dF81c3"], // WMATIC-USDT
        [1e6], // 1 USDT
        [true], // swap WMATIC for USDT
        "0x14e27d280553673CB82be1B6F60eB4D25122aeA9" // target recipient
    )
    console.log("Test result: ", testResult);

}

dumpTokens();