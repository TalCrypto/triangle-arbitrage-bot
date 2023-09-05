const { ethers } = require('ethers');
const EventEmitter = require('events');

const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    PRIVATE_KEY,
    SIGNING_KEY,
    BOT_ADDRESS,
    SAFE_TOKENS,
} = require('./constants');
const { logger, blacklistTokens } = require('./constants');
const { loadAllPoolsFromV2, loadAllPoolsFromV3, keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools } = require('./utils');
const { exactTokensOut, computeProfit, optimizeAmountIn } = require('./simulator');
const { Bundler, Path, Flashloan, ZERO_ADDRESS } = require('./bundler');
const tokens = require('./tokens');
const fs = require('fs');

async function main() {
    logger.info("Program started");
    const provider = new ethers.providers.JsonRpcProvider(HTTPS_URL);
    const providerReserves = new ethers.providers.JsonRpcProvider(HTTPS2_URL);
    const factoryAddresses_v2 = [
        '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', // QuickSwap
        '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', // SushiSwap
    ];
    const factoryAddresses_v3 = ['0x1F98431c8aD98523631AE4a59f267346ea31F984']; // Uniswap v3

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
    let pools = Object.assign(pools_v2, pools_v3);
    logger.info(`Initial pool count: ${Object.keys(pools).length}`);

    // Fetch the reserves of all pools
    let s = new Date();
    await batchReserves(providerReserves, pools, [], 1000, 5);
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
    
    // Transaction handler (can send transactions to mempool / bundles to Flashbots)
    let bundler = new Bundler(
        PRIVATE_KEY,
        SIGNING_KEY,
        HTTPS_URL,
        BOT_ADDRESS,
    );
    await bundler.setup();
    
    let eventEmitter = new EventEmitter();

    streamNewBlocks(WSS_URL, eventEmitter);
    
    eventEmitter.on('event', async (event) => {
        if (event.type == 'block') {
            let blockNumber = event.blockNumber;
            logger.info(`▪️ New Block #${blockNumber}`);

            // Display profit every 30 blocks
            if (blockNumber % 30 == 0) {
                let sessionEnd = new Date();
                let sessionDuration = (sessionEnd - sessionStart) / 1000;
                logger.info("===== Profit Recap =====")
                
                // For each token, display the profit in decimals
                for (let token in profitStore) {
                    let profit = Number(profitStore[token]) / 10**safeTokens[token].decimals;
                    logger.info(`${safeTokens[token].symbol}: ${profit} (${token})`);
                }
                logger.info(`Session duration: ${sessionDuration} seconds (${sessionDuration / 60} minutes) (${sessionDuration / 60 / 60} hours)`);
                logger.info("========================")
            }

            // Find pools that were updated in the last block
            s = new Date();
            let touchedPools = await findUpdatedPools(providerReserves, blockNumber, pools);
            e = new Date();
            logger.info(`${(e - s) / 1000} s - Found ${touchedPools.length} touched pools by reading block events`);
            if (touchedPools.length == 0) return; // No pools were updated, no need to continue

            // Fetch the reserves of all the pools that were updated
            s = new Date();
            await batchReserves(provider, pools, touchedPools, 100, 1);
            e = new Date();
            logger.info(`${(e - s) / 1000} s - Touched pools reserve call took: `);
        
            // Find paths that use the touched pools
            const MAX_PATH_EVALUATION = 1000; // Share that value between each touched pool
            let touchedPaths = [];
            for (let pool of touchedPools) { // Remember, touchedPools is a list of addresses
                if (pool in pathsByPool) {
                    // Find the new paths, check if they are not already in touchedPaths
                    let newPaths = pathsByPool[pool].slice(0, Math.floor(MAX_PATH_EVALUATION/touchedPools.length));
                    newPaths = newPaths.filter(path => !touchedPaths.includes(path));
                    touchedPaths = touchedPaths.concat(newPaths);
                }
            }
            logger.info(`Found ${touchedPaths.length} touched paths`);


            // For each path, compute the optimal amountIn to trade, and the profit
            s = new Date();
            let profitablePaths = [];
            for (let path of touchedPaths) {
                let amountIn = optimizeAmountIn(path);
                if (amountIn === 0n) continue; // Grossly unprofitable

                let profit = computeProfit(amountIn, path);

                // Store the profit and amountIn values
                path.amountIn = amountIn;
                path.profit = profit;
                
                if (profit > 0n) {
                    profitablePaths.push(path);
                } else {
                    // Unprofitable
                }
            }

            // The following part will be removed in the following commits.
            let spreads = {};
            for (let idx = 0; idx < Object.keys(paths).length; idx++) {
                let path = paths[idx];
                let touchedPath = touchedPools.reduce((touched, pool) => {
                    return touched + (path.hasPool(pool) ? 1 : 0)
                }, 0);
                if (touchedPath > 0) {
                    let priceQuote = path.simulateV2Path(1, reserves);
                    let spread = (priceQuote / (10 ** usdcDecimals) - 1) * 100;
                    if (spread > 0) {
                        spreads[idx] = spread;
                    }
                }
            }

            console.log('▶️ Spread over 0%: ', spreads);
        }
    });
}

module.exports = {
    main,
};