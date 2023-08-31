const { ethers } = require('ethers');
const EventEmitter = require('events');

const {
    HTTPS_URL,
    WSS_URL,
    PRIVATE_KEY,
    SIGNING_KEY,
    BOT_ADDRESS,
    SAFE_TOKENS,
} = require('./constants');
const { logger, blacklistTokens } = require('./constants');
const { loadAllPoolsFromV2, loadAllPoolsFromV3, poolsFromPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { getTouchedPoolReserves } = require('./utils');
const { Bundler, Path, Flashloan, ZERO_ADDRESS } = require('./bundler');
const tokens = require('./tokens');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider(HTTPS_URL);

    const factoryAddresses_v2 = ['0xc35DADB65012eC5796536bD9864eD8773aBc74C4']; // Sushi
    const factoryAddresses_v3 = ['0x1F98431c8aD98523631AE4a59f267346ea31F984']; // Uniswap v3

    // Load v2 pools
    let pools_v2 = await loadAllPoolsFromV2(HTTPS_URL, factoryAddresses_v2);
    logger.info(`Initial V2 pool count: ${Object.keys(pools_v2).length}`);
    
    // Load v3 pools
    let pools_v3 = await loadAllPoolsFromV3(HTTPS_URL, factoryAddresses_v3);
    logger.info(`Initial V3 pool count: ${Object.keys(pools_v3).length}`);

    // Merge v2 and v3 pools
    let pools = Object.assign(pools_v2, pools_v3);

    // Load decimals of tokens (only needed for displaying token amounts, not needed by the bot)
    let tokenList = tokens.exctractTokens(pools);
    // ...

    // Load safe tokens, from which we will constitute the root of our arb paths
    const safeTokens = SAFE_TOKENS; //await tokens.getSafeTokens(); // Only works on Ethereum mainnet
    logger.info(`Safe token count: ${Object.keys(safeTokens).length}`);
    
    // Find paths of length 2,3 starting from each safe token.
    let s = new Date();
    let paths = generatePaths(safeTokens, pools, 3);
    let e = new Date();
    logger.info(`Built ${Object.keys(paths).length} paths in ${(e - s) / 1000} seconds`);

    // Filter out pools that are not used in arb paths
    pools = poolsFromPaths(paths);
    logger.info(`New pool count: ${Object.keys(pools).length}`);

    s = new Date();
    let reserves = await batchReserves(HTTPS_URL, Object.keys(pools));
    e = new Date();
    logger.info(`Batch reserves call took: ${(e - s) / 1000} seconds`);

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

            let touchedReserves = await getTouchedPoolReserves(provider, blockNumber);
            let touchedPools = [];
            for (let address in touchedReserves) {
                let reserve = touchedReserves[address];
                if (address in reserves) {
                    reserves[address] = reserve;
                    touchedPools.push(address);
                }
            }

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