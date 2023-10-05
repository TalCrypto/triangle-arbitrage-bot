const { ethers } = require('ethers');
const EventEmitter = require('events');

const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    PRIVATE_KEY,
    TRADE_CONTRACT_ABI,
    SENDER_ADDRESS,
    TRADE_CONTRACT_ADDRESS,
    SAFE_TOKENS,
    CHAIN_ID,
    TX_ENDPOINTS,
} = require('./constants');
const { logger } = require('./constants');
const { keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools, preSelectPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools, clipBigInt, displayStats } = require('./utils');
const { exactTokensOut, computeProfit, optimizeAmountIn } = require('./simulator');
const fs = require('fs');
const path = require('path');

async function main() {
    logger.info("Program started");
    const provider = new ethers.providers.JsonRpcProvider(HTTPS_URL);
    const providerReserves = new ethers.providers.JsonRpcProvider(HTTPS2_URL);
    const factoryAddresses_v2 = [
        '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', // QuickSwap
        '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', // SushiSwap
    ];
    const factoryAddresses_v3 = ['0x1F98431c8aD98523631AE4a59f267346ea31F984']; // Uniswap v3

    // Reading approved tokens from file into an object
    // let approvedTokens = JSON.parse(fs.readFileSync('data/dump_token_info.json', 'utf8'));
    let approvedTokens = JSON.parse(fs.readFileSync('data/dump_valid_tokens.json', 'utf8'));
    logger.info(`Approved token count: ${Object.keys(approvedTokens).length}`);

    let pools_v2, pools_v3;
    // Fetch v2, v3 pools
    // logger.info("Fetching v2 pools... (this can take a while)");
    // pools_v2 = await loadAllPoolsFromV2(provider, factoryAddresses_v2);
    // logger.info("Fetching v3 pools... (this can take a while)");
    // pools_v3 = await loadAllPoolsFromV3(provider, factoryAddresses_v3);
    // fs.writeFileSync('data/v2_pools.json', JSON.stringify(pools_v2)); // Save v2 pools to file using fs
    // fs.writeFileSync('data/v3_pools.json', JSON.stringify(pools_v3)); // Save v3 pools to file using fs
    
    // Read pools from file if pool_v2 and pool_v3 are empty
    if (!pools_v2 && !pools_v3) {
        logger.info("Loading pools from file...");
        pools_v2 = JSON.parse(fs.readFileSync('data/v2_pools.json', 'utf8'));
        pools_v3 = JSON.parse(fs.readFileSync('data/v3_pools.json', 'utf8'));
        logger.info(`Initial V2 pool count: ${Object.keys(pools_v2).length}`);
        logger.info(`Initial V3 pool count: ${Object.keys(pools_v3).length}`);
    }

    // Merge v2 and v3 pools
    let pools = {};
    // DEBUG: Ignore V3 pools for now 
    // logger.info("DEBUG: Ignoring V3 pools");
    // for (let pool of Object.values(pools_v2)) {
    for (let pool of Object.values(Object.assign(pools_v2, pools_v3))) {
        // Check if both of the tokens of the pool are approved
        if (approvedTokens[pool.token0] && approvedTokens[pool.token1]) {
            pools[pool.address] = pool;
        }
    }
    logger.info(`Initial pool count: ${Object.keys(pools).length}`);

    // Fetch the reserves of all pools
    let s = new Date();
    let blockNumber = await provider.getBlockNumber();
    await batchReserves(provider, pools, [], 100, 10, blockNumber);
    let e = new Date();
    logger.info(`Batch reserves call took: ${(e - s) / 1000} seconds`);

    // Filter out pools with no liquidity
    pools = keepPoolsWithLiquidity(pools);

    // Load decimals of tokens (only needed for displaying token amounts, not needed by the bot)
    // let tokenList = tokens.exctractTokens(pools);
    // ...

    // Load safe tokens, from which we will constitute the root of our arb paths
    const safeTokens = SAFE_TOKENS;
    logger.info(`Safe token count: ${Object.keys(safeTokens).length}`);
    
    // Find paths of length 2,3 starting from each safe token.
    let paths = []
    s = new Date();
    for (let token in safeTokens) {
        let tokenPaths = generatePaths([token], pools, 3);
        paths = paths.concat(tokenPaths);
        // fs.writeFileSync(`data/paths_${token.substring(0, 6)}.json`, JSON.stringify(tokenPaths)); // Save paths to file using fs
    }
    e = new Date();
    logger.info(`Built ${Object.keys(paths).length} paths in ${(e - s) / 1000} seconds`);
    
    // // Load all paths from files (Will loose pool object reference. Make functions pure ??)
    // let pathsFiles = fs.readdirSync('data').filter(fn => fn.startsWith('paths_'));
    // paths = [];
    // for (let pathsFile of pathsFiles) {
    //     // Load paths from file using fs
    //     let tokenPaths = JSON.parse(fs.readFileSync(`data/${pathsFile}`, 'utf8'));
    //     paths = paths.concat(tokenPaths);
    // }
    // logger.info(`Loaded ${Object.keys(paths).length} paths from files`);

    // Filter out pools that are not used in arb paths
    pools = extractPoolsFromPaths(paths);
    logger.info(`New pool count: ${Object.keys(pools).length}`);

    // Index the paths by the pools they use, for faster lookup. Sort the paths.
    let pathsByPool = indexPathsByPools(paths);
    logger.info(`Indexed paths by pool`);
    
    // Start session timer, display profit every 30 blocks
    let sessionStart = new Date();
    let lastGasPrice = await provider.getGasPrice();
    let lastTxCount = await provider.getTransactionCount(SENDER_ADDRESS);
    let poolsToRefresh = Object.keys(pools); // Once the bot starts receiving blocks, we refresh gradually the reserves of every pool, ensuring that our profit math is always correct.
    let hasRefreshed = false; // When flips to true, purge dataStore to get replace transient latency data with steady-state data.
    
    // Data collection //
    // Latency for various operations
    const dataStore = {
        events: [], // Store the time in ms to read the events of blocks
        reserves: [], // Store the time in ms it took to read the reserves of pools
        block: [], // Store the total time in ms it took to process a block
    };
    // Opportunities found
    const profitStore = {}; // Store the profit of each root token
    for (let token in safeTokens) {
        profitStore[token] = 0n;
    }
    
    // Start listening to new blocks using websockets (TODO: measure latency)
    let eventEmitter = new EventEmitter();
    streamNewBlocks(WSS_URL, eventEmitter);
    eventEmitter.on('event', async (event) => {
        if (event.type == 'block') {
            blockNumber = event.blockNumber;
            let sblock = new Date();

            try {
                logger.info(`=== New Block #${blockNumber}`);

                // Display profit every 30 blocks
                if (blockNumber % 30 == 0) {
                    displayStats(sessionStart, logger, safeTokens, dataStore, profitStore);
                }

                // Find pools that were updated in the last block
                s = new Date();
                let touchedPools = await findUpdatedPools(provider, blockNumber, pools, approvedTokens);
                e = new Date();
                dataStore.events.push(e - s);
                logger.info(`${(e - s) / 1000} s - Found ${touchedPools.length} touched pools by reading block events. Block #${blockNumber}`);

                // Find paths that use the touched pools
                const MAX_PATH_EVALUATION = 500; // Share that value between each touched pool
                let touchedPaths = [];
                for (let pool of touchedPools) { // Remember, touchedPools is a list of addresses
                    if (pool in pathsByPool) {
                        // Find the new paths, check if they are not already in touchedPaths
                        let newPaths = preSelectPaths(pathsByPool[pool], MAX_PATH_EVALUATION/touchedPools.length, 0.5);
                        
                        // Check if the new touched paths are not already in touchedPaths, and concat the new ones.
                        newPaths = newPaths.filter(path => !touchedPaths.includes(path));
                        touchedPaths = touchedPaths.concat(newPaths);
                    }
                }
                logger.info(`Found ${touchedPaths.length} touched paths. Block #${blockNumber}`);

                // If there still are pools to refresh, process them. 
                const N_REFRESH = 200;
                // Append N_REFRESH pools and touched pools
                let fetchPools = poolsToRefresh.slice(0, N_REFRESH);
                fetchPools = fetchPools.concat(touchedPools);
                if (fetchPools.length > 0) {
                    logger.info(`Fetching reserves for ${fetchPools.length} involved pools. Block #${blockNumber}`);
                    s = new Date();
                    await batchReserves(providerReserves, pools, fetchPools, 100, 5, blockNumber);
                    e = new Date();
                    dataStore.reserves.push(e - s);
                    logger.info(`${(e - s) / 1000} s - Batch reserves call. Block #${blockNumber}`);
                }

                // Update poolsToRefresh array
                poolsToRefresh = poolsToRefresh.slice(N_REFRESH);
                // There are still some remaining pools to refresh. Will be done in the next block.
                if (poolsToRefresh.length > 0) {
                    logger.info(`Remaining pools to refresh: ${poolsToRefresh.length}. Aborting block #${blockNumber}`);
                    hasRefreshed = false;
                    return;
                } else if (!hasRefreshed) {
                    // We have refreshed all the pools (poolsToRefresh is empty), and we have not yet purged the dataStore.
                    // Purge the dataStore, and set hasRefreshed to true.
                    dataStore.events = [];
                    dataStore.reserves = [];
                    dataStore.block = [];
                    hasRefreshed = true;
                }

                let elapsed = new Date() - sblock;
                if (elapsed > 1000) {
                    // If the time elapsed is > 1000ms, we skip the arbitrage transaction
                    logger.info(`Time margin too low (block elapsed = ${elapsed} ms), skipping block #${blockNumber}`);
                    return;
                }

                // Make sure that there are paths to evaluate.
                if (touchedPaths.length == 0) {
                    logger.info(`No touched paths, skipping block #${blockNumber}`);
                    return;
                }
                
                // For each path, compute the optimal amountIn to trade, and the profit
                s = new Date();
                let profitablePaths = [];
                logger.info(`Evaluating ${touchedPaths.length} touched paths. Block #${blockNumber}`);
                for (let path of touchedPaths) {
                    let amountIn = optimizeAmountIn(path);
                    if (amountIn === 0n) continue; // Grossly unprofitable

                    let profitwei = computeProfit(amountIn, path);
                    if (profitwei <= 0n) continue; // Unprofitable
                    let profitusd = safeTokens[path.rootToken].usd * Number(profitwei) / 10**safeTokens[path.rootToken].decimals;

                    // Store the profit and amountIn values
                    path.amountIn = amountIn;
                    path.profitwei = profitwei;
                    path.profitusd = profitusd;
                    
                    profitablePaths.push(path);
                }
                
                profitablePaths.sort((pathA, pathB) =>{
                    return pathB.profitusd - pathA.profitusd;
                });
                const path = profitablePaths[0];
                e = new Date();
                logger.info(`${(e - s) / 1000} s - Found ${profitablePaths.length} profitable paths. Block #${blockNumber}`);
                
                if (profitablePaths.length == 0) {
                    // No profitable paths, skip arbitrage transaction
                    logger.info(`No profitable paths, skipping arbitrage transaction.`);
                    return;
                }
                
                if (path.profitusd < 0.02) {
                    // Profit of the best path is too low, skip arbitrage transaction
                    logger.info(`Profit too low ($${path.profitusd} USD), skipping arbitrage transaction.`);
                    return;
                }
                
                // Display the profitable path
                logger.info(`Profitable path: $${path.profitusd} ${SAFE_TOKENS[path.rootToken].symbol} ${Number(path.profitwei)/10**SAFE_TOKENS[path.rootToken].decimals} block #${blockNumber}`);

                // Store profit in profitStore
                profitStore[path.rootToken] += path.profitwei
                
                // Display info about the path. Prepare the parameters
                path.amounts = [path.amountIn.toString()];
                let amountOut = path.amountIn;
                for (let i = 0; i < path.pools.length; i++) {
                    let pool = path.pools[i];
                    let zfo = path.directions[i];
                    let amountIn = amountOut; // Previous amountOut value
                    amountOut = exactTokensOut(amountIn, pool, zfo);
                    // DEBUG: Clip to the millionth. To avoid tx fails due to rounding errors.
                    // Should be removed since the V3 math is fixed now.
                    // amountOut = clipBigInt(amountOut, 6); // Maybe clip to the 7/8th ?
                    path.amounts.push(amountOut.toString());
                }

                elapsed = new Date() - sblock;
                if (elapsed > 1000) {
                    // If the time elapsed is > 1000ms, we skip the arbitrage transaction
                    logger.info(`Time margin too low (block elapsed = ${elapsed} ms), skipping block #${blockNumber}`);
                    return;
                }
                
                // Send arbitrage transaction
                logger.info(`!!!!!!!!!!!!! Sending arbitrage transaction... Should land in block #${blockNumber + 1} `);

                // Print info about the path/pools/token amounts
                for (let i = 0; i < path.pools.length; i++) {
                    let pool = path.pools[i];
                    let zfo = path.directions[i];
                    let tin = zfo ? pool.token0 : pool.token1;
                    let tout = zfo ? pool.token1 : pool.token0;
                    if (pool.version == 2) {
                        logger.info(`pool v:${pool.version} a:${pool.address} z:${zfo} tin:${tin} (${approvedTokens[tin].symbol}) tout:${tout} (${approvedTokens[tout].symbol}) in:${path.amounts[i]} out:${path.amounts[i+1]} r0:${pool.extra.reserve0} r1:${pool.extra.reserve1}`);
                    } else if (pool.version == 3) {
                        logger.info(`pool v:${pool.version} a:${pool.address} z:${zfo} tin:${tin} (${approvedTokens[tin].symbol}) tout:${tout} (${approvedTokens[tout].symbol}) in:${path.amounts[i]} out:${path.amounts[i+1]} s:${pool.extra.sqrtPriceX96} l:${pool.extra.liquidity}`);
                    }
                }

                // Set up the callback data for each step of the arbitrage path. Start from the last step.
                let data3 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], 
                [
                    [ 
                        0, // Specify a 'token transfer' action
                        ethers.utils.hexlify([]) 
                    ],
                    path.directions[2] ? path.pools[2].token0 : path.pools[2].token1, // token2
                    path.amounts[2]
                ]); // Repay pool2

                let data2 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], [ 
                    [
                        path.pools[2].version, // pool2 version (2 or 3)
                        ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ], [path.pools[2].address, path.amounts[3], TRADE_CONTRACT_ADDRESS, path.directions[2], data3])
                    ], // Call pool2
                    path.directions[1] ? path.pools[1].token0 : path.pools[1].token1, // token1
                    path.amounts[1]
                ]); // Repay pool1

                // In the callback of pool0, call pool1 and repay path.amounts[0] to pool0
                let data1 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], [
                    [
                        path.pools[1].version, // pool1 version (2 or 3)
                        ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ], [path.pools[1].address, path.amounts[2], TRADE_CONTRACT_ADDRESS, path.directions[1], data2])
                    ], // Call pool1
                    path.directions[0] ? path.pools[0].token0 : path.pools[0].token1, // token0
                    path.amounts[0]
                ]); // Repay pool0

                // Action that triggers the chain. Starts with a call to pool0.
                let initialAction = {
                    actionType: path.pools[0].version, // pool0 version (2 or 3)
                    rawData: ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
                        [path.pools[0].address, path.amounts[1], TRADE_CONTRACT_ADDRESS, path.directions[0], data1])
                }; // Call pool0

                // Create a signer
                const signer = new ethers.Wallet(PRIVATE_KEY);
                const account = signer.connect(provider);
                const tradeContract = new ethers.Contract(TRADE_CONTRACT_ADDRESS, TRADE_CONTRACT_ABI, account);

                // Tx overrides
                let overrides = {
                    gasPrice: lastGasPrice.mul(125).div(100), // Add 10%
                    gasLimit: 1000000, // 1M gas
                    nonce: lastTxCount,
                };

                // Send arbitrage transaction
                let tx = await tradeContract.execute(initialAction, overrides);
                
                // Use JSON-RPC instead of ethers.js to send the signed transaction
                let tipPercent = 75; // 75%
                let start = Date.now();
                let txhash = await provider.send("eth_sendRawTransaction", [await signer.signTransaction({
                    to: TRADE_CONTRACT_ADDRESS,
                    data: tradeContract.interface.encodeFunctionData("execute", [initialAction]),
                    type: 2,
                    gasLimit: 1000000, // 1M gas
                    maxFeePerGas: lastGasPrice.mul(100 + tipPercent).div(100),
                    maxPriorityFeePerGas: lastGasPrice.mul(tipPercent).div(100),
                    nonce: lastTxCount,
                    chainId: CHAIN_ID,
                    value: 0,
                })]);
                logger.info(`Transaction sent in ${Date.now() - start}ms`);
                logger.info(`tx hash: ${txhash}`);
                lastTxCount++;

            } catch (e) {
                logger.error(`Error while processing block #${blockNumber}: ${e}`);
            } finally {
                try {
                    // Block was processed quickly, we have time to fetch the gas price
                    let pricePromise = provider.getGasPrice();
                    let txPromise = provider.getTransactionCount(SENDER_ADDRESS);
                    pricePromise.then((price) => {
                        lastGasPrice = price;
                    });
                    txPromise.then((txCount) => {
                        lastTxCount = txCount;
                    });
                    await Promise.all([pricePromise, txPromise]);
                    logger.info(`Gas price: ${Number(lastGasPrice)/10**9} GWei, tx nonce count: ${lastTxCount}`);
                } catch (e) {
                    logger.error(`Error when fetching gasPrice/txCount: ${e} block #${blockNumber}`);
                }
                let blockElapsed = new Date() - sblock;
                dataStore.block.push(blockElapsed);
                logger.info(`=== End of block #${blockNumber} (took ${(blockElapsed) / 1000} s)`);
            }
        }
    });
}

module.exports = {
    main,
};