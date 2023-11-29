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
const {
    loadAllPoolsFromV2,
    loadAllPoolsFromV3,
    keepPoolsWithLiquidity,
    extractPoolsFromPaths,
    indexPathsByPools,
    preSelectPaths,
} = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools, clipBigInt, displayStats } = require('./utils');
const {
    exactTokensOut,
    computeProfit,
    optimizeAmountIn,
} = require('./simulator');
const tokens = require('./tokens');
const fs = require('fs');

// Use in combination with a local forked node synced at the target block:
// anvil --fork-url https://polygon-mainnet.g.alchemy.com/v2/xxx --fork-block-number BN

async function sendTx() {
    // Send arbitrage transaction
    console.log('Sending arbitrage transaction...');

    // Use local anvil node
    const provider = new ethers.providers.JsonRpcProvider(
        'http://127.0.0.1:8545'
    );

    // Create a signer
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const account = signer.connect(provider);
    const tradeContract = new ethers.Contract(
        TRADE_CONTRACT_ADDRESS,
        TRADE_CONTRACT_ABI,
        account
    );

    // Block number: 48368076

    // Pool addresses
    let address0 = '0x7F567cE133B0B69458fC318af06Eee27642865be';
    let address1 = '0x29BeA4A8C74Be114c23954c1390DA12A9539E864';
    let address2 = '0xC3286373599dD5Af2A17a572eBb7561F05f88BEC';

    // Pool versions
    let version0 = 3;
    let version1 = 3;
    let version2 = 3;

    // Pool zeroForOne directions
    let zfo0 = true;
    let zfo1 = false;
    let zfo2 = true;

    // Token addresses
    let token0 = '0x94Ab9E4553fFb839431E37CC79ba8905f45BfBeA';
    let token1 = '0xa3Fa99A148fA48D14Ed51d610c367C61876997F1';
    let token2 = '0x0308a3a9c433256aD7eF24dBEF9c49C8cb01300A';

    // Amounts:
    amountOut = clipBigInt(amountOut, 6); // Maybe clip to the 7/8th ?
    let amountArray = [
        '88276911',
        '13672620000000',
        '486051200000000',
        '127190',
    ];

    // Token amounts involved
    let amount0 = amountArray[0]; // Example: 1e18
    let amount1 = amountArray[1]; // 1813221787760297984
    let amount2 = amountArray[2]; // 1530850444050214912
    let amount3 = amountArray[3]; // 1323519076544782336
    // Profit = 1323519076544782336 - 1e18 = 323519076544782336

    // Set up the callback data for each step of the arbitrage path. Start from the last step.
    let data3 = ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint, bytes)', 'address', 'uint'],
        [
            [
                0, // Specify a 'token transfer' action
                ethers.utils.hexlify([]),
            ],
            token2,
            amount2,
        ]
    ); // Repay pool2
    console.log(`data3: ${data3}`);

    let data2 = ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint, bytes)', 'address', 'uint'],
        [
            [
                version2, // pool2 version (2 or 3)
                ethers.utils.defaultAbiCoder.encode(
                    ['address', 'uint', 'address', 'bool', 'bytes'],
                    [address2, amount3, TRADE_CONTRACT_ADDRESS, zfo2, data3]
                ),
            ], // Call pool2
            token1,
            amount1,
        ]
    ); // Repay pool1
    console.log(`data2: ${data2}`);

    // In the callback of pool0, call pool1 and repay amount0 to pool0
    let data1 = ethers.utils.defaultAbiCoder.encode(
        ['tuple(uint, bytes)', 'address', 'uint'],
        [
            [
                version1, // pool1 version (2 or 3)
                ethers.utils.defaultAbiCoder.encode(
                    ['address', 'uint', 'address', 'bool', 'bytes'],
                    [address1, amount2, TRADE_CONTRACT_ADDRESS, zfo1, data2]
                ),
            ], // Call pool1
            token0,
            amount0,
        ]
    ); // Repay pool0
    console.log(`data1: ${data1}`);

    // Action that triggers the chain. Starts with a call to pool0.
    let initialAction = {
        actionType: version0, // pool0 version (2 or 3)
        rawData: ethers.utils.defaultAbiCoder.encode(
            ['address', 'uint', 'address', 'bool', 'bytes'],
            [address0, amount1, TRADE_CONTRACT_ADDRESS, zfo0, data1]
        ),
    }; // Call pool0
    console.log(`initialAction data: ${initialAction.rawData}`);

    // Fetch current gas price
    let gasPrice = await provider.getGasPrice();
    console.log('gasPrice', gasPrice);

    // Fetch current nonce
    let nonce = await provider.getTransactionCount(signer.address);
    console.log('nonce', nonce);

    // Run execute() function
    let start = Date.now();
    let overrides = {
        gasPrice: gasPrice.mul(125).div(100), // Add 10%
        gasLimit: 1000000, // 1M gas
        nonce: nonce,
    };
    let tx = await tradeContract.execute(initialAction, overrides);

    // Use direct json-rpc call instead, to send the signed transaction
    // let tx = await provider.send("eth_sendRawTransaction", [await signer.signTransaction({
    //     to: TRADE_CONTRACT_ADDRESS,
    //     data: tradeContract.interface.encodeFunctionData("execute", [initialAction]),
    //     gasPrice: gasPrice.mul(125).div(100), // Add 10%
    //     gasLimit: 1000000, // 1M gas
    //     nonce: nonce,
    // })]);
    // console.log(`tx hash: ${tx.hash}`);
    console.log(`Transaction sent in ${Date.now() - start}ms`);
    console.log('tx', tx);

    // Wait for the transaction to be mined
    tx.wait().then((receipt) => {
        if (receipt.status === 1) {
            console.log(
                `Transaction was mined in block ${receipt.blockNumber}`
            );
        } else {
            console.log(`Transaction failed in block ${receipt.blockNumber}`);
        }
    });
}

function test() {
    let pool0 = {
        version: 3,
        address: '0x7F567cE133B0B69458fC318af06Eee27642865be',
        token0: '0x94Ab9E4553fFb839431E37CC79ba8905f45BfBeA',
        token1: '0xa3Fa99A148fA48D14Ed51d610c367C61876997F1',
        extra: {
            fee: 5, //in bps
            tickSpacing: 10,
            liquidity: 1653250242535099755n,
            sqrtPriceX96: 1959647542012149644571046656372452n,
        },
    };

    let inAmount = 3309741n;
    let zfo = true;
    let outAmount = exactTokensOut(inAmount, pool0, zfo);
    console.log(`outAmount: ${outAmount}`);
    // 3309741=2023827782983463 (repay 3309742)
    // 3309742=2023828394459613 (repay 3309743)

    let pool1 = {
        version: 2,
        address: '0x40A8772A6C917569d28A136A458E3051B96b4AC3',
        token0: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        token1: '0xe118e8b6dc166CD83695825eB1d30e792435Bb00',
        extra: {
            fee: 30, //in bps
            reserve0: 104055071036826676n,
            reserve1: 11389559353915257381981n,
        },
    };

    inAmount = 2023827782983462n;
    zfo = true;
    outAmount = exactTokensOut(inAmount, pool0, zfo);
    console.log(`outAmount: ${outAmount}`);
    // 2023827782983463=18361760677374910369
}

// sendTx();
test();
