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
// anvil --fork-url https://polygon-mainnet.g.alchemy.com/v2/xxx --fork-block-number 48006705

async function sendTx() {
    // Send arbitrage transaction
    console.log("Sending arbitrage transaction...");

    // Use local anvil node
    const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");

    // Create a signer
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const account = signer.connect(provider);
    const tradeContract = new ethers.Contract(TRADE_CONTRACT_ADDRESS, TRADE_CONTRACT_ABI, account);

    // Block number: 48006705

    // Pool addresses
    let address0 = '0x1A6F6af2864b1f059A2E070140e373D6e3AAA2A1';
    let address1 = '0x6CE2400ABd570b38eE2937D44521ee77773eA7e4';
    let address2 = '0x4152ea409F10F7d6efDCa92149fDE430A8712b02';

    // Pool versions
    let version0 = 2;
    let version1 = 2;
    let version2 = 2;

    // Pool zeroForOne directions
    let zfo0 = false;
    let zfo1 = true;
    let zfo2 = true;

    // Token addresses
    let token0 = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
    let token1 = '0x204820B6e6FEae805e376D2C6837446186e57981';
    let token2 = '0x7Ecb5699D8E0a6572E549Dc86dDe5A785B8c29BC';

    // Amounts:
    let amountArray = [
        "21586",
        "12723444981068115933",
        "3980637485678051984410",
        "22230"
    ];

    // Token amounts involved
    let amount0 = amountArray[0]; // Example: 1e18
    let amount1 = amountArray[1]; // 1813221787760297984
    let amount2 = amountArray[2]; // 1530850444050214912
    let amount3 = amountArray[3]; // 1323519076544782336
    // Profit = 1323519076544782336 - 1e18 = 323519076544782336

    // Set up the callback data for each step of the arbitrage path. Start from the last step.
    let data3 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], 
    [
        [ 
            0, // Specify a 'token transfer' action
            ethers.utils.hexlify([]) 
        ],
        token2,
        amount2
    ]); // Repay pool2
    console.log(`data3: ${data3}`)

    let data2 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], [ 
        [
            version2, // pool2 version (2 or 3)
            ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ], [address2, amount3, TRADE_CONTRACT_ADDRESS, zfo2, data3])
        ], // Call pool2
        token1,
        amount1
    ]); // Repay pool1
    console.log(`data2: ${data2}`)

    // In the callback of pool0, call pool1 and repay amount0 to pool0
    let data1 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], [
        [
            version1, // pool1 version (2 or 3)
            ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ], [address1, amount2, TRADE_CONTRACT_ADDRESS, zfo1, data2])
        ], // Call pool1
        token0,
        amount0
    ]); // Repay pool0
    console.log(`data1: ${data1}`)

    // Action that triggers the chain. Starts with a call to pool0.
    let initialAction = {
        actionType: version0, // pool0 version (2 or 3)
        rawData: ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
            [address0, amount1, TRADE_CONTRACT_ADDRESS, zfo0, data1])
    }; // Call pool0
    console.log(`initialAction data: ${initialAction.rawData}`)

    // Fetch current gas price
    let lastGasPrice = await provider.getGasPrice();
    console.log("gasPrice", lastGasPrice);

    // Tx overrides
    let overrides = {
        gasPrice: lastGasPrice.mul(110).div(100), // Add 10%
        gasLimit: 1000000, // 1M gas
    };

    // Run execute() function
    let tx = await tradeContract.execute(initialAction, overrides);
    console.log(`tx hash: ${tx.hash}`);

    // Wait for the transaction to be mined
    tx.wait().then((receipt) => {
        if (receipt.status === 1) {
            console.log(`Transaction was mined in block ${receipt.blockNumber}`);
        } else {
            console.log(`Transaction failed in block ${receipt.blockNumber}`);
        }
    });

    // Check the balance of the account
    
}

sendTx();