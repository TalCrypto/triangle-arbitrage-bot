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
const { logger } = require('./constants');
const { keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools, preSelectPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools } = require('./utils');
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
    // DEBUG: Ignore V3 pools for now ////////////////////////////
    // for (let pool of Object.values(Object.assign(pools_v2, pools_v3))) {
    for (let pool of Object.values(pools_v2)) {
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
    // const safeTokens = await tokens.getSafeTokens(); // Only works on Ethereum mainnet. TODO: Find a way to make it work on Polygon
    const safeTokens = SAFE_TOKENS;
    const profitStore = {}; // Store the profit of each root token
    for (let token in safeTokens) {
        profitStore[token] = 0n;
    }
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
    
    // Formattiing: display the cumulative opportunity profit for each token
    const dataStore = {
        events: [], // Store the time in ms to read the events of blocks
        reserves: [], // Store the time in ms it took to read the reserves of pools
        block: [], // Store the total time in ms it took to process a block
    };
        
    // Start listening to new blocks using websockets (TODO: measure latency)
    let eventEmitter = new EventEmitter();
    streamNewBlocks(WSS_URL, eventEmitter);
    eventEmitter.on('event', async (event) => {
        if (event.type == 'block') {
            let blockNumber = event.blockNumber;
            logger.info(`=== New Block #${blockNumber}`);
            sblock = new Date();

            // Display profit every 30 blocks
            if (blockNumber % 30 == 0) {
                let sessionEnd = new Date();
                let sessionDuration = (sessionEnd - sessionStart) / 1000;
                logger.info("===== Profit Recap =====")
                
                // For each token, display the profit in decimals
                for (let token in profitStore) {
                    let profit = Number(profitStore[token]) / 10**safeTokens[token].decimals;
                    logger.info(`${safeTokens[token].symbol}: ${profit} $${profit*safeTokens[token].usd} (${token})`);
                }
                logger.info(`Session duration: ${sessionDuration} seconds (${sessionDuration / 60} minutes) (${sessionDuration / 60 / 60} hours)`);
                logger.info("========================")

                // DEBUG
                // Print time decile values: events, reserves, block
                dataStore.events.sort((a, b) => a - b);
                dataStore.reserves.sort((a, b) => a - b);
                dataStore.block.sort((a, b) => a - b);
                let eventDeciles = [];
                let reserveDeciles = [];
                let blockDeciles = [];
                for (let i = 0; i < 10; i++) {
                    eventDeciles.push(dataStore.events[Math.floor(i * dataStore.events.length / 10)]);
                    reserveDeciles.push(dataStore.reserves[Math.floor(i * dataStore.reserves.length / 10)]);
                    blockDeciles.push(dataStore.block[Math.floor(i * dataStore.block.length / 10)]);
                }
                logger.info("///// Time Stats /////")
                logger.info(`Event deciles: ${eventDeciles}`);
                logger.info(`Reserve deciles: ${reserveDeciles}`);
                logger.info(`Block deciles: ${blockDeciles}`);
                logger.info("//////////////////////")
            }

            // Find pools that were updated in the last block
            s = new Date();
            let touchedPools = await findUpdatedPools(provider, blockNumber, pools);
            e = new Date();
            dataStore.events.push(e - s);
            logger.info(`${(e - s) / 1000} s - Found ${touchedPools.length} touched pools by reading block events. Block #${blockNumber}`);
            if (touchedPools.length == 0) return; // No pools were updated, no need to continue

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


            // DEBUG
            // Update the reserves of every pool involved in a touched path
            let involvedPoolsSet = new Set();
            for (let path of touchedPaths) {
                for (let pool of path.pools) {
                    involvedPoolsSet.add(pool.address);
                }
            }
            let involvedPoolsList = Array.from(involvedPoolsSet);
            logger.info(`Fetching reserves for ${involvedPoolsList.length} involved pools. Block #${blockNumber}`);
            s = new Date();
            await batchReserves(providerReserves, pools, involvedPoolsList, 1000, 2, blockNumber);
            e = new Date();
            dataStore.reserves.push(e - s);
            logger.info(`${(e - s) / 1000} s - Batch reserves call. Block #${blockNumber}`);


            // For each path, compute the optimal amountIn to trade, and the profit
            s = new Date();
            let profitablePaths = [];
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
            
            } else if (path.profitusd < 0.02) {
                // Profit of the best path is too low, skip arbitrage transaction
                logger.info(`Profit too low ($${path.profitusd} USD), skipping arbitrage transaction.`);
            
            } else {
                // Display the profitable path
                logger.info(`Profitable path: $${path.profitusd} ${SAFE_TOKENS[path.rootToken].symbol} ${Number(path.profitwei)/10**SAFE_TOKENS[path.rootToken].decimals} block #${blockNumber}`);

                // Store profit in profitStore
                profitStore[path.rootToken] += path.profitwei
                
                // Display info about the path. Prepare the parameters
                let amountArray = [path.amountIn.toString()];
                let amountOut = path.amountIn;
                for (let i = 0; i < path.pools.length; i++) {
                    let pool = path.pools[i];
                    let zfo = path.directions[i];
                    let amountIn = amountOut; // Previous amountOut value
                    amountOut = exactTokensOut(amountIn, pool, zfo);
                    // DEBUG: Round to the millionth. To avoid tx fails due to rounding errors.
                    // Seems to not be needed for now.
                    // amountOut = Math.floor(Number(amountOut) / 10**6) * 10**6;
                    amountArray.push(amountOut.toString());
                }

                let elapsed = new Date() - sblock;
                if (elapsed > 1000) {
                    // If the time elapsed is > 1000ms, we skip the arbitrage transaction
                    logger.info(`Time margin too low (block elapsed = ${elapsed} ms), skipping arbitrage transaction.`);
                    return;
                }
                try{
                    // Send arbitrage transaction
                    logger.info("!!!!!!!!!!!!! Sending arbitrage transaction...");
                                        
                    // Create a signer
                    const signer = new ethers.Wallet(PRIVATE_KEY);
                    const account = signer.connect(provider);
                    const tradeContract = new ethers.Contract(TRADE_CONTRACT_ADDRESS, TRADE_CONTRACT_ABI, account);

                    // Token amounts involved
                    let amount0 = amountArray[0]; // Example: 1e18
                    let amount1 = amountArray[1]; // 1813221787760297984
                    let amount2 = amountArray[2]; // 1530850444050214912
                    let amount3 = amountArray[3]; // 1323519076544782336
                    // Profit = 1323519076544782336 - 1e18 = 323519076544782336

                    // zeroForOne parameter, for each pool
                    let zfo0 = path.directions[0];
                    let zfo1 = path.directions[1];
                    let zfo2 = path.directions[2];

                    // Token addresses
                    let token0 = path.directions[0] ? path.pools[0].token0 : path.pools[0].token1;
                    let token1 = path.directions[0] ? path.pools[0].token1 : path.pools[0].token0;
                    let token2 = path.directions[1] ? path.pools[1].token1 : path.pools[1].token0;

                    
                    // for (let i = 0; i < path.pools.length; i++) {
                    //     let pool = path.pools[i];
                    //     if (pool.version == 2) {
                    //         logger.info(`pool v:${pool.version} a:${pool.address} z:${zfo} tin:${zfo?pool.token0:pool.token1} tout:${zfo?pool.token1:pool.token0} in:${amountIn} out:${amountOut} r0:${pool.extra.reserve0} r1:${pool.extra.reserve1}`);
                    //     } else if (pool.version == 3) {
                    //         logger.info(`pool v:${pool.version} a:${pool.address} z:${zfo} tin:${zfo?pool.token0:pool.token1} tout:${zfo?pool.token1:pool.token0} in:${amountIn} out:${amountOut} s:${pool.extra.sqrtPriceX96} l:${pool.extra.liquidity}`);
                    //     }
                    // }

                        // Set up the callback data for each step of the arbitrage path. Start from the last step.
                        let data3 = ethers.utils.defaultAbiCoder.encode([ 'uint', 'bytes' ], [ 
                            0, // Specify a 'token transfer' action
                            ethers.utils.hexlify([]) ],
                            token2, amount2); // Repay pool2

                        let data2 = ethers.utils.defaultAbiCoder.encode([ 'uint', 'bytes' ], [ 
                            path.pools[2].version, // pool2 version (2 or 3)
                            ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
                                [path.pools[2].address, amount3, TRADE_CONTRACT_ADDRESS, zfo2, data3] )], // Call pool2
                            token1, amount1); // Repay pool1

                        // In the callback of pool0, call pool1 and repay amount0 to pool0
                        let data1 = ethers.utils.defaultAbiCoder.encode([ 'uint', 'bytes' ], [ 
                            path.pools[1].version, // pool1 version (2 or 3)
                            ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
                                [path.pools[1].address, amount2, TRADE_CONTRACT_ADDRESS, zfo1, data2] )], // Call pool1
                            token0, amount0); // Repay pool0

                        // Action that triggers the chain. Starts with a call to pool0.
                        let initialAction = {
                            action: path.pools[0].version, // pool0 version (2 or 3)
                            data: ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
                                [path.pools[0].address, amount1, TRADE_CONTRACT_ADDRESS, zfo0, data1] )
                        }; // Call pool0

                        // Execute arbitrage
                        // let tx = await tradeContract.execute(initialAction);
                        let tx = await tradeContract.execute([initialAction.action, initialAction.data]);
                        logger.info(`Transaction sent. Transaction hash: ${tx.hash}`);

                        await tx.wait();
                        logger.info(`Transaction mined: ${tx.hash}`);

                        let receipt = await tx.wait();
                        logger.info(`Gas used: ${receipt.gasUsed.toString()}`);

                        // Disgraceful shutdown
                        // fgfdgdfgdf.sdtsdfi();
                    } catch (e) {
                        logger.error(`Error: ${e}`);
                    }
                }
            }

            eblock = new Date();
            dataStore.block.push(eblock - sblock);
            logger.info(`=== End of block #${blockNumber} (took ${(eblock - sblock) / 1000} s)`);
        }
    });
}

module.exports = {
    main,
};