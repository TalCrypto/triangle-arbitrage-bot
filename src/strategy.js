const { ethers } = require('ethers');

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
    HTTPS_ENDPOINTS,
    WS_LOCAL,
    MULTICALL_ABI,
    MULTICALL_ADDRESS
} = require('./constants');

const { logger } = require('./constants');
const { keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools, preSelectPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools, clipBigInt, displayStats, extractLogsFromSimulation, getPoolsFromLogs } = require('./utils');
const { exactTokensOut, computeProfit, optimizeAmountIn } = require('./simulator');
const { buildTx, buildBlankTx, buildLegacyTx } = require('./bundler');
const fs = require('fs');
const path = require('path');


async function main() {
    logger.info("Program started");
    const wsProvider = new ethers.providers.WebSocketProvider(WS_LOCAL);
    let providers = HTTPS_ENDPOINTS.map(endpoint => new ethers.providers.JsonRpcProvider(endpoint));
    providers = providers.concat([wsProvider]);
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
    await batchReserves(wsProvider, pools, [], 100, 10, await wsProvider.getBlockNumber());
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
    let lastGasPrice = await wsProvider.getGasPrice();
    let lastTxCount = await wsProvider.getTransactionCount(SENDER_ADDRESS);
    let lastBlockNumber = await wsProvider.getBlockNumber(); // Used to abandon old blocks, when a new one is received.
    let poolsToRefresh = Object.keys(pools); // Once the bot starts receiving blocks, we refresh gradually the reserves of every pool, ensuring that our profit math is always correct.
    let hasRefreshed = false; // When flips to true, purge dataStore to get replace transient latency data with steady-state data.

    // Data collection //
    // Latency for various operations
    const dataStore = {
        events: [], // Store the time in ms to read the events of blocks
        reserves: [], // Store the time in ms it took to read the reserves of pools
        block: [], // Store the total time in ms it took to process a block
        tradeKeys: {}, // Store the (pool0, pool1, pool2) keys, identifying similar trades
    };
    // Opportunities found
    const profitStore = {}; // Store the profit of each root token
    for (let token in safeTokens) {
        profitStore[token] = 0n;
    }

    // Start listening to new blocks using websockets
    wsProvider.on('block', async (blockNumber) => {
        // Start of block timer
        let sblock = new Date();

        // Old block guard
        if (blockNumber <= lastBlockNumber) {
            // We have already processed this block, or an older one. Ignore it.
            logger.info(`Ignoring old block #${blockNumber} (latest block is #${lastBlockNumber})`);
            return;
        } else {
            // We are currently processing the latest block
            lastBlockNumber = blockNumber;
        }

        try {
            logger.info(`=== New Block #${blockNumber}`);

            // Display profit every 30 blocks
            if (blockNumber % 30 == 0) {
                displayStats(sessionStart, logger, safeTokens, dataStore, profitStore);
            }

            // Find pools that were updated in the last block
            s = new Date();
            let touchedPools = await findUpdatedPools(wsProvider, blockNumber, pools, approvedTokens);
            e = new Date();
            dataStore.events.push(e - s);
            logger.info(`${(e - s) / 1000} s - Found ${touchedPools.length} touched pools by reading block events. Block #${blockNumber}`);

            // Find paths that use the touched pools
            const MAX_PATH_EVALUATION = 500; // Share that value between each touched pool
            let touchedPaths = [];
            for (let pool of touchedPools) { // Remember, touchedPools is a list of addresses
                if (pool in pathsByPool) {
                    // Find the new paths, check if they are not already in touchedPaths
                    let newPaths = preSelectPaths(pathsByPool[pool], MAX_PATH_EVALUATION / touchedPools.length, 0.5);

                    // Check if the new touched paths are not already in touchedPaths, and concat the new ones.
                    newPaths = newPaths.filter(path => !touchedPaths.includes(path));
                    touchedPaths = touchedPaths.concat(newPaths);

                }
            }

            logger.info(`Found ${touchedPaths.length} touched paths. Block #${blockNumber}`);

            // Check if we are still working on the latest block
            if (blockNumber < lastBlockNumber) {
                logger.info(`New block mined (${lastBlockNumber}), skipping block #${blockNumber}`);
                return;
            }

            // If there still are pools to refresh, process them. 
            const N_REFRESH = 200;
            // Append N_REFRESH pools and touched pools
            let fetchPools = poolsToRefresh.slice(0, N_REFRESH);
            fetchPools = fetchPools.concat(touchedPools);
            if (fetchPools.length > 0) {
                logger.info(`Fetching reserves for ${fetchPools.length} involved pools. Block #${blockNumber}`);
                s = new Date();
                await batchReserves(wsProvider, pools, fetchPools, 1000, 5, blockNumber);
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
        } catch (e) {
            logger.error(`Error while processing block #${blockNumber}: ${e}`);
        } finally {
            let blockElapsed = new Date() - sblock;
            dataStore.block.push(blockElapsed);
            logger.info(`=== End of block #${blockNumber} (took ${(blockElapsed) / 1000} s)`);
        }
    });



    const multiCallInterface = new ethers.utils.Interface(MULTICALL_ABI);

    let pendingSwapTxData = []

    wsProvider.on('pending', async (pendingTx) => {
        let sblock = new Date();
        const txnData = await wsProvider.getTransaction(pendingTx);

        // the local node can't get the tranaction data if it has been announced
        // so we skip in this case
        if (!txnData) return;

        const txRecp = await wsProvider.getTransactionReceipt(pendingTx);

        // Make sure the pending transaction hasn't been mined
        if (txRecp !== null) {
            return;
        }

        try {
            // simulate the pending transaction
            // doesn't change the EVM states of mainnet, hence there is no gas costs
            const response = await wsProvider.send(
                "debug_traceCall",
                [
                    {
                        from: txnData['from'],
                        to: txnData['to'],
                        data: txnData['data'],
                    },
                    "latest",
                    {
                        tracer: "callTracer",
                        tracerConfig: { withLog: true }
                    }
                ]
            );

            let logs = extractLogsFromSimulation(response)

            if (logs.length == 0) return;

            let touchablePoolAddresses = [];
            let touchablePoolsV2 = [];
            let touchablePoolsV3 = [];

            const poolInfo = getPoolsFromLogs(logs);
            touchablePoolAddresses = poolInfo.touchablePoolAddresses;
            touchablePoolsV2 = poolInfo.touchablePoolsV2;
            touchablePoolsV3 = poolInfo.touchablePoolsV3;

            if (touchablePoolAddresses.length > 0) {
                logger.info(`===== Found an opportunity transaction ${pendingTx} : ${touchablePoolAddresses.length} touchable pools =====`);
                pendingSwapTxData.push(txnData);
            } else return;

            // if there are over 1 swap pendings, then simulate them with multicall smart contract
            if (pendingSwapTxData.length > 1) {

                // filter transactions that are not mined yet
                const tempWithFilter = await Promise.all(pendingSwapTxData.map(async (txData) => {
                    const receipt = await wsProvider.getTransactionReceipt(txData['hash']);
                    return {
                        value: txData,
                        filter: receipt === null ?? false
                    };
                }));
                pendingSwapTxData = tempWithFilter.filter(e => e.filter).map(e => e.value);

                // sort pending transactions by the gas price
                pendingSwapTxData.sort((a, b) => {
                    if (b['gasPrice'].gt(a['gasPrice'])) {
                        return 1;
                    } else {
                        return 0
                    }
                });

                // simulate multi pending tx with the multicall smart contract
                const calls = pendingSwapTxData.map(txData => ({
                    target: txData['to'],
                    allowFailure: true,
                    callData: txData['data']
                }));
                const multiResp = await wsProvider.send(
                    "debug_traceCall",
                    [
                        {
                            to: MULTICALL_ADDRESS,
                            data: multiCallInterface.encodeFunctionData("aggregate3", [calls]),
                        },
                        "latest",
                        {
                            tracer: "callTracer",
                            tracerConfig: { withLog: true }
                        }
                    ]
                );

                // extract logs from the multi call simulation
                logs = extractLogsFromSimulation(multiResp);

                // get pool infos from the log
                const poolInfoWithMulti = getPoolsFromLogs(logs);
                touchablePoolAddresses = poolInfoWithMulti.touchablePoolAddresses;
                touchablePoolsV2 = poolInfoWithMulti.touchablePoolsV2;
                touchablePoolsV3 = poolInfoWithMulti.touchablePoolsV3;
            }

            // skip if the pools are not syned
            if (!hasRefreshed) return;

            // Find paths that use the touchable pools
            const MAX_PATH_EVALUATION = 500; // Share that value between each touchable pool
            let touchablePaths = [];
            for (let poolAddress of touchablePoolAddresses) {
                if (poolAddress in pathsByPool) {
                    // Find the new paths, check if they are not already in touchedPaths
                    let newPaths = preSelectPaths(pathsByPool[poolAddress], MAX_PATH_EVALUATION / touchablePoolAddresses.length, 0.5);

                    // Check if the new touched paths are not already in touchedPaths, and concat the new ones.
                    newPaths = newPaths.filter(path => !touchablePaths.includes(path));
                    touchablePaths = touchablePaths.concat(newPaths);
                }
            }

            // clone touchablePaths and modify it with the estimate values so that the paths won't be changed that is only updated evey block
            const clonedTouchablePaths = structuredClone(touchablePaths);
            for (let path of clonedTouchablePaths) {
                for (let pool of path.pools) {
                    for (let estimatedPool of touchablePoolsV2) {
                        if (estimatedPool.address == pool.address) {
                            pool.extra.reserve0 = estimatedPool.reserve0;
                            pool.extra.reserve1 = estimatedPool.reserve1;
                            pool.extra.liquidity = estimatedPool.liquidity;
                        }
                    }
                    for (let estimatedPool of touchablePoolsV3) {
                        if (estimatedPool.address == pool.address) {
                            pool.extra.sqrtPriceX96 = estimatedPool.sqrtPriceX96;
                            pool.extra.liquidity = estimatedPool.liquidity;
                        }
                    }
                }
            }

            // For each path, compute the optimal amountIn to trade, and the profit
            s = new Date();
            let profitablePaths = [];
            logger.info(`Evaluating ${clonedTouchablePaths.length} touchable paths.`);
            for (let path of clonedTouchablePaths) {
                let amountIn = optimizeAmountIn(path);
                if (amountIn === 0n) continue; // Grossly unprofitable

                let profitwei = computeProfit(amountIn, path);
                if (profitwei <= 0n) continue; // Unprofitable
                let profitusd = safeTokens[path.rootToken].usd * Number(profitwei) / 10 ** safeTokens[path.rootToken].decimals;

                // Store the profit and amountIn values
                path.amountIn = amountIn;
                path.profitwei = profitwei;
                path.profitusd = profitusd;

                profitablePaths.push(path);
            }

            if (profitablePaths.length == 0) {
                // No profitable paths, skip arbitrage transaction
                logger.info(`No profitable paths, skipping arbitrage transaction.`);
                return;
            }

            profitablePaths.sort((pathA, pathB) => {
                return pathB.profitusd - pathA.profitusd;
            });
            const path = profitablePaths[0];
            e = new Date();
            logger.info(`${(e - s) / 1000} s - Found ${profitablePaths.length} profitable paths`);

            if (path.profitusd < 0.02) {
                // Profit of the best path is too low, skip arbitrage transaction
                logger.info(`Profit too low ($${path.profitusd} USD), skipping arbitrage transaction.`);
                return;
            }

            // Display the profitable path
            logger.info(`Profitable path: $${path.profitusd} ${SAFE_TOKENS[path.rootToken].symbol} ${Number(path.profitwei) / 10 ** SAFE_TOKENS[path.rootToken].decimals}`);

            // Store profit in profitStore
            profitStore[path.rootToken] += path.profitwei

            // elapsed = new Date() - sblock;

            // Check if the trade has 3 pools (2 pools not yet implemented)
            if (path.pools.length != 3) {
                logger.info(`Path has ${path.pools.length} pools, skipping transaction ${pendingTx}`);
                return;
            }

            // Create a signer
            const signer = new ethers.Wallet(PRIVATE_KEY);
            const account = signer.connect(wsProvider);
            const tradeContract = new ethers.Contract(TRADE_CONTRACT_ADDRESS, TRADE_CONTRACT_ABI, account);

            lastTxCount = await wsProvider.getTransactionCount(SENDER_ADDRESS)
            let txObject = await buildLegacyTx(path, tradeContract, approvedTokens, logger, signer, lastTxCount, txnData['gasPrice'].mul(8).div(10));
            const blockNumber = await wsProvider.getBlockNumber();

            // Make sure the pending transaction hasn't been mined
            if (txRecp !== null) {
                return;
            }

            // Send arbitrage transaction
            logger.info(`!!!!!!!!!!!!! Sending arbitrage transaction... Should land in block #${blockNumber + 2} `);

            // Send the transaction
            const tx = await wsProvider.send("eth_sendRawTransaction", txObject);
            // fs.writeFileSync(`data/transactions_${blockNumber}.json`, JSON.stringify({ oppo: pendingTx, arbi: tx }));
            // let promises = [];
            // let successCount = 0;
            // let failedEndpoints = [];
            // promises = promises.concat(providers.map((pvdr) => pvdr.send("eth_sendRawTransaction", txObject)));
            // promises.forEach((promise, index) => {
            //     promise.then(() => {
            //         successCount++;
            //     }).catch((e) => {
            //         failedEndpoints.push(HTTPS_ENDPOINTS[index]);
            //         logger.error(`Error while sending to ${HTTPS_ENDPOINTS[index]}`);
            //     });
            // });

            // Wait for all the promises to resolve
            logger.info(`Finished sending. End-to-end delay ${(Date.now() - sblock) / 1000} s`);
            // await Promise.all(promises);
            // logger.info(`Successfully received by ${successCount} endpoints. E2E ${(Date.now() - start) / 1000} s. Tx hash ${await promises[0]} Block #${blockNumber}`);
            // lastTxCount++;
        } catch (e) {
            logger.error(`Error while processing transaction ${pendingTx}: ${e}`);
        }
    })
}

module.exports = {
    main,
};
