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
    MULTICALL_ADDRESS,
} = require('./constants');

const { logger } = require('./constants');
const {
    keepPoolsWithLiquidity,
    extractPoolsFromPaths,
    indexPathsByPools,
    preSelectPaths,
} = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const {
    findUpdatedPools,
    clipBigInt,
    displayStats,
    extractLogsFromSimulation,
    getPoolsFromLogs,
    isSamePendingArrays,
} = require('./utils');
const {
    exactTokensOut,
    computeProfit,
    optimizeAmountIn,
    simulatePendingTransactions,
} = require('./simulator');
const {
    buildBackRunTx,
    buildLegacyTx,
    buildFrontRunTx,
    buildTx,
} = require('./bundler');
const fs = require('fs');

async function main() {
    logger.info('Program started');
    const wsProvider = new ethers.providers.WebSocketProvider(WS_LOCAL);
    let providers = HTTPS_ENDPOINTS.map(
        (endpoint) => new ethers.providers.JsonRpcProvider(endpoint)
    );
    providers = providers.concat([wsProvider]);
    const factoryAddresses_v2 = [
        '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', // QuickSwap
        '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', // SushiSwap
    ];
    const factoryAddresses_v3 = ['0x1F98431c8aD98523631AE4a59f267346ea31F984']; // Uniswap v3

    // Reading approved tokens from file into an object
    let dumpTokens = JSON.parse(
        fs.readFileSync('data/dump_token_info.json', 'utf8')
    );
    let approvedTokenArray = JSON.parse(
        fs.readFileSync('contracts/forge/external/validTokens.json', 'utf8')
    )['valid'];
    let approvedTokens = {};
    for (let approvedTokenAddress of approvedTokenArray) {
        if (approvedTokenAddress != ethers.constants.AddressZero) {
            approvedTokens[approvedTokenAddress] =
                dumpTokens[approvedTokenAddress];
        }
    }
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
        logger.info('Loading pools from file...');
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
    await batchReserves(
        wsProvider,
        pools,
        [],
        100,
        10,
        await wsProvider.getBlockNumber()
    );
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
    let paths = [];
    s = new Date();
    for (let token in safeTokens) {
        let tokenPaths = generatePaths([token], pools, 3);
        paths = paths.concat(tokenPaths);
        // fs.writeFileSync(`data/paths_${token.substring(0, 6)}.json`, JSON.stringify(tokenPaths)); // Save paths to file using fs
    }
    e = new Date();
    logger.info(
        `Built ${Object.keys(paths).length} paths in ${(e - s) / 1000} seconds`
    );

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

    let pendingTxArray = []; // used to store pending transactions
    let lastSubmittedBlock = 0; // used to avoid submitting in the next block because self transactions are not considered as pending ones

    // Start listening to new blocks using websockets
    wsProvider.on('block', async (blockNumber) => {
        // Start of block timer
        let sblock = new Date();

        // Old block guard
        if (blockNumber <= lastBlockNumber) {
            // We have already processed this block, or an older one. Ignore it.
            logger.info(
                `Ignoring old block #${blockNumber} (latest block is #${lastBlockNumber})`
            );
            return;
        } else {
            // We are currently processing the latest block
            lastBlockNumber = blockNumber;
        }

        try {
            logger.info(`=== New Block #${blockNumber}`);

            // filter out transactions that are not mined
            // ignore older than 3 blocks because they cann't be mined forever
            const tempWithFilter = await Promise.all(
                pendingTxArray.map(async (e) => {
                    const receipt = await wsProvider.getTransactionReceipt(
                        e.txnData['hash']
                    );
                    return {
                        value: e,
                        filter:
                            (receipt === null ?? false) &&
                            blockNumber - e.blockNumber < 3,
                    };
                })
            );
            pendingTxArray = tempWithFilter
                .filter((e) => e.filter)
                .map((e) => e.value);

            logger.info(
                `Number of pending transactions: ${pendingTxArray.length}`
            );

            // Display profit every 30 blocks
            if (blockNumber % 30 == 0) {
                displayStats(
                    sessionStart,
                    logger,
                    safeTokens,
                    dataStore,
                    profitStore
                );
            }

            // Find pools that were updated in the last block
            s = new Date();
            let touchedPools = await findUpdatedPools(
                wsProvider,
                blockNumber,
                pools,
                approvedTokens
            );
            e = new Date();
            dataStore.events.push(e - s);
            logger.info(
                `${(e - s) / 1000} s - Found ${
                    touchedPools.length
                } touched pools by reading block events. Block #${blockNumber}`
            );

            // If there still are pools to refresh, process them.
            const N_REFRESH = 200;
            // Append N_REFRESH pools and touched pools
            let fetchPools = poolsToRefresh.slice(0, N_REFRESH);
            fetchPools = fetchPools.concat(touchedPools);
            if (fetchPools.length > 0) {
                logger.info(
                    `Fetching reserves for ${fetchPools.length} involved pools. Block #${blockNumber}`
                );
                s = new Date();
                await batchReserves(
                    wsProvider,
                    pools,
                    fetchPools,
                    1000,
                    5,
                    blockNumber
                );
                e = new Date();
                dataStore.reserves.push(e - s);
                logger.info(
                    `${
                        (e - s) / 1000
                    } s - Batch reserves call. Block #${blockNumber}`
                );
            }

            // Update poolsToRefresh array
            poolsToRefresh = poolsToRefresh.slice(N_REFRESH);
            // There are still some remaining pools to refresh. Will be done in the next block.
            if (poolsToRefresh.length > 0) {
                logger.info(
                    `Remaining pools to refresh: ${poolsToRefresh.length}. Aborting block #${blockNumber}`
                );
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

            // filter pending transactions that will be mined at n+1 block regardless of gas setting
            const bfPendingTxArray = pendingTxArray.filter(
                (e) => e.blockNumber == blockNumber - 1
            );

            logger.info(
                `Number of beforehand transactions: ${bfPendingTxArray.length}`
            );

            let touchablePoolAddresses = [];
            let touchablePoolsV2 = [];
            let touchablePoolsV3 = [];

            if (bfPendingTxArray.length > 0) {
                const { txnData } = bfPendingTxArray[0];
                // simulate the pending transaction
                // doesn't change the EVM states of mainnet, hence there is no gas costs
                const response = await wsProvider.send('debug_traceCall', [
                    {
                        from: txnData['from'],
                        to: txnData['to'],
                        data: txnData['data'],
                    },
                    'latest',
                    {
                        tracer: 'callTracer',
                        tracerConfig: { withLog: true },
                    },
                ]);

                let logs = extractLogsFromSimulation(response);

                const poolInfo = getPoolsFromLogs(logs, pools);
                touchablePoolAddresses = poolInfo.touchablePoolAddresses;
                touchablePoolsV2 = poolInfo.touchablePoolsV2;
                touchablePoolsV3 = poolInfo.touchablePoolsV3;
            }

            touchedPools = touchedPools.concat(touchablePoolAddresses);

            // Find paths that use the touched pools
            const MAX_PATH_EVALUATION = 500; // Share that value between each touched pool
            let touchedPaths = [];
            for (let pool of touchedPools) {
                // Remember, touchedPools is a list of addresses
                if (pool in pathsByPool) {
                    // Find the new paths, check if they are not already in touchedPaths
                    let newPaths = preSelectPaths(
                        pathsByPool[pool],
                        MAX_PATH_EVALUATION / touchedPools.length,
                        0.5
                    );

                    // Check if the new touched paths are not already in touchedPaths, and concat the new ones.
                    newPaths = newPaths.filter(
                        (path) => !touchedPaths.includes(path)
                    );
                    touchedPaths = touchedPaths.concat(newPaths);
                }
            }

            logger.info(
                `Found ${touchedPaths.length} touched paths. Block #${blockNumber}`
            );

            // Make sure that there are paths to evaluate.
            if (touchedPaths.length == 0) {
                logger.info(`No touched paths, skipping block #${blockNumber}`);
                return;
            }

            // Check if we are still working on the latest block
            if (blockNumber < lastBlockNumber) {
                logger.info(
                    `New block mined (${lastBlockNumber}), skipping block #${blockNumber}`
                );
                return;
            }

            // clone touchablePaths and modify it with the estimate values so that the paths won't be changed that is only updated evey block
            const clonedTouchablePaths = structuredClone(touchedPaths);
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
                            pool.extra.sqrtPriceX96 =
                                estimatedPool.sqrtPriceX96;
                            pool.extra.liquidity = estimatedPool.liquidity;
                        }
                    }
                }
            }

            // For each path, compute the optimal amountIn to trade, and the profit
            s = new Date();
            let profitablePaths = [];
            logger.info(
                `Evaluating ${clonedTouchablePaths.length} touched paths. Block #${blockNumber}`
            );
            for (let path of clonedTouchablePaths) {
                let amountIn = optimizeAmountIn(path);
                if (amountIn === 0n) continue; // Grossly unprofitable

                let profitwei = computeProfit(amountIn, path);
                if (profitwei <= 0n) continue; // Unprofitable
                let profitusd =
                    (safeTokens[path.rootToken].usd * Number(profitwei)) /
                    10 ** safeTokens[path.rootToken].decimals;

                // Store the profit and amountIn values
                path.amountIn = amountIn;
                path.profitwei = profitwei;
                path.profitusd = profitusd;

                profitablePaths.push(path);
            }

            profitablePaths.sort((pathA, pathB) => {
                return pathB.profitusd - pathA.profitusd;
            });
            const path = profitablePaths[0];
            e = new Date();
            logger.info(
                `${(e - s) / 1000} s - Found ${
                    profitablePaths.length
                } profitable paths. Block #${blockNumber}`
            );

            if (profitablePaths.length == 0) {
                // No profitable paths, skip arbitrage transaction
                logger.info(
                    `No profitable paths, skipping arbitrage transaction.`
                );
                return;
            }

            if (path.profitusd < 0.02) {
                // Profit of the best path is too low, skip arbitrage transaction
                logger.info(
                    `Profit too low ($${path.profitusd} USD), skipping arbitrage transaction.`
                );
                return;
            }

            // Display the profitable path
            logger.info(
                `Profitable path: $${path.profitusd} ${
                    SAFE_TOKENS[path.rootToken].symbol
                } ${
                    Number(path.profitwei) /
                    10 ** SAFE_TOKENS[path.rootToken].decimals
                } block #${blockNumber}`
            );

            // Store profit in profitStore
            profitStore[path.rootToken] += path.profitwei;

            // Check if the trade has 3 pools (2 pools not yet implemented)
            if (path.pools.length != 3) {
                logger.info(
                    `Path has ${path.pools.length} pools, skipping block #${blockNumber}`
                );
                return;
            }

            // Create a signer
            const signer = new ethers.Wallet(PRIVATE_KEY);
            const account = signer.connect(wsProvider);
            const tradeContract = new ethers.Contract(
                TRADE_CONTRACT_ADDRESS,
                TRADE_CONTRACT_ABI,
                account
            );

            lastTxCount = await wsProvider.getTransactionCount(SENDER_ADDRESS);

            // Make sure that we are still working on the latest block
            if (blockNumber < lastBlockNumber) {
                logger.info(
                    `New block mined (${lastBlockNumber}), skipping block #${blockNumber}`
                );
                return;
            }

            const competiveTxArray = pendingTxArray.filter(
                (e) => e.blockNumber == blockNumber
            );

            logger.info(
                `Number of competive traransactions: ${competiveTxArray.length}`
            );

            let txObject;
            if (competiveTxArray.length > 0) {
                // build a front transaction so that it can be placed before the competive tx
                txObject = await buildFrontRunTx(
                    path,
                    tradeContract,
                    approvedTokens,
                    logger,
                    signer,
                    lastTxCount,
                    competiveTxArray[competiveTxArray.length - 1].txnData
                );
            } else {
                let lastGasPrice = await wsProvider.getGasPrice();
                // if there aren't competive transactions, build normal legacy transactions
                txObject = await buildLegacyTx(
                    path,
                    tradeContract,
                    approvedTokens,
                    logger,
                    signer,
                    lastTxCount,
                    lastGasPrice
                );
            }

            if (lastSubmittedBlock + 1 == blockNumber) {
                logger.info('Already submitted before the block');
                return;
            }

            lastSubmittedBlock = blockNumber;

            // Send arbitrage transaction
            logger.info(
                `!!!!!!!!!!!!! Sending arbitrage transaction... Should land in block #${
                    blockNumber + 2
                }`
            );

            const tx = await wsProvider.send(
                'eth_sendRawTransaction',
                [txObject]
            );

            //   logger.info(`${JSON.stringify(pendingTxArray)}`);

            logger.info(
                `Finished sending. End-to-end delay ${
                    (Date.now() - sblock) / 1000
                } s`
            );
        } catch (e) {
            logger.error(`Error while processing block #${blockNumber}: ${e}`);
        } finally {
            let blockElapsed = new Date() - sblock;
            dataStore.block.push(blockElapsed);
            logger.info(
                `=== End of block #${blockNumber} (took ${
                    blockElapsed / 1000
                } s)`
            );
        }
    });

    wsProvider.on('pending', async (pendingTx) => {
        const txnData = await wsProvider.getTransaction(pendingTx);

        // the local node can't get the tranaction data if it has been announced
        // so we skip in this case
        if (!txnData) return;

        try {
            // simulate the pending transaction
            // doesn't change the EVM states of mainnet, hence there is no gas costs
            const response = await wsProvider.send('debug_traceCall', [
                {
                    from: txnData['from'],
                    to: txnData['to'],
                    data: txnData['data'],
                },
                'latest',
                {
                    tracer: 'callTracer',
                    tracerConfig: { withLog: true },
                },
            ]);

            let logs = extractLogsFromSimulation(response);

            if (logs.length == 0) return;

            let touchablePoolAddresses = [];

            const poolInfo = getPoolsFromLogs(logs, pools);
            touchablePoolAddresses = poolInfo.touchablePoolAddresses;
            touchablePoolsV2 = poolInfo.touchablePoolsV2;
            touchablePoolsV3 = poolInfo.touchablePoolsV3;

            if (touchablePoolAddresses.length == 0) return;

            logger.info(
                `===== Found an opportunity transaction ${pendingTx} : ${touchablePoolAddresses.length} touchable pools =====`
            );

            const blockNumber = await wsProvider.getBlockNumber();

            cachePendingTransaction(blockNumber, txnData);
        } catch (e) {
            logger.error(
                `Error while processing transaction ${pendingTx}: ${e}`
            );
        }
    });
}

module.exports = {
    main,
};
