// Description: Sends an arbitrage transaction to the Trade contract.
const { ethers } = require('ethers');
const EventEmitter = require('events');

const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    PRIVATE_KEY,
    TRADE_CONTRACT_ABI,
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

async function sendTx() {
    // Send arbitrage transaction
    console.log("Sending arbitrage transaction...");

    // Use local anvil node
    const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");

    // Create a signer
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const account = signer.connect(provider);
    const tradeContract = new ethers.Contract(TRADE_CONTRACT_ADDRESS, TRADE_CONTRACT_ABI, account);

    // Pool addresses
    let address0 = '0x76e0Fe81C8b291Bd28cBc3c59eBebA22c10b82Ec';
    let address1 = '0xe31b2eC0cfbEeDdAb8949220EAFe2a24767D5293';
    let address2 = '0xbf61E1D82bD440cb9da11d325c046f029a663890';

    // Pool versions
    let version0 = 2;
    let version1 = 2;
    let version2 = 2;

    // Pool zeroForOne directions
    let zfo0 = true;
    let zfo1 = false;
    let zfo2 = true;

    // Token addresses
    let token0 = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
    let token1 = '0x7D645CBbCAdE2A130bF1bf0528b8541d32D3f8Cf';
    let token2 = '0x6f7C932e7684666C9fd1d44527765433e01fF61d';

    // Amounts:
    let amountArray = [
        "277545136541",
        "353332533813866614834582",
        "2676499895281",
        "2036726326701"
    ];

    // Token amounts involved
    let amount0 = amountArray[0]; // Example: 1e18
    let amount1 = amountArray[1]; // 1813221787760297984
    let amount2 = amountArray[2]; // 1530850444050214912
    let amount3 = amountArray[3]; // 1323519076544782336
    // Profit = 1323519076544782336 - 1e18 = 323519076544782336

    // Set up the callback data for each step of the arbitrage path. Start from the last step.
    let data3 = ethers.utils.defaultAbiCoder.encode([ 'uint', 'bytes' ], [ 
        0, // Specify a 'token transfer' action
        ethers.utils.hexlify([]) ],
        token2, amount2); // Repay pool2
    console.log(`data3: ${data3}`)

    let data2 = ethers.utils.defaultAbiCoder.encode([ 'uint', 'bytes' ], [ 
        version2, // pool2 version (2 or 3)
        ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
            [address2, amount3, TRADE_CONTRACT_ADDRESS, zfo2, data3] )], // Call pool2
        token1, amount1); // Repay pool1
    console.log(`data2: ${data2}`)

    // In the callback of pool0, call pool1 and repay amount0 to pool0
    let data1 = ethers.utils.defaultAbiCoder.encode([ 'uint', 'bytes' ], [ 
        version1, // pool1 version (2 or 3)
        ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
            [address1, amount2, TRADE_CONTRACT_ADDRESS, zfo1, data2] )], // Call pool1
        token0, amount0); // Repay pool0
    console.log(`data1: ${data1}`)

    // Action that triggers the chain. Starts with a call to pool0.
    let initialAction = {
        action: version0, // pool0 version (2 or 3)
        data: ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
            [address0, amount1, TRADE_CONTRACT_ADDRESS, zfo0, data1] )
    }; // Call pool0
    console.log(`initialAction: ${initialAction}`)

    // Execute arbitrage
    // let tx = await tradeContract.execute(initialAction);
    let tx = await tradeContract.execute([initialAction.action, initialAction.data]);
    console.log(`Transaction sent: ${tx.hash}`);

    await tx.wait();
    console.log(`Transaction mined: ${tx.hash}`);

    let receipt = await tx.wait();
    console.log(`Gas used: ${receipt.gasUsed.toString()}`);
}

sendTx();