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
const { loadAllPoolsFromV2, loadAllPoolsFromV3 } = require('./pools');
const { generateTriangularPaths } = require('./paths');
const { batchGetUniswapV2Reserves } = require('./multi');
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
    logger.info(`Initial V2 pool count: ${Object.keys(pools).length}`);
    
    // Load v3 pools
    let pools_v3 = await loadAllPoolsFromV3(HTTPS_URL, factoryAddresses_v3);
    logger.info(`Initial V3 pool count: ${Object.keys(pools_v3).length}`);

    // Load decimals of tokens (only needed for displaying token amounts, not needed by the bot)
    let tokenList = tokens.exctractTokens([pools_v2, pools_v3]);
    // ...

    // Load safe tokens, from which we will constitute the root of our arb paths
    // const safeTokens = await tokens.getSafeTokens(); // Only works on Ethereum mainnet
    const safeTokens = SAFE_TOKENS;
    logger.info(`Safe token count: ${Object.keys(safeTokens).length}`);
    

    // We should not limit ourselves to one root token.
    // Use USDC as the arb path root.
    // const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    // const usdcDecimals = 6;
    let paths = generateTriangularPaths(pools, usdcAddress);

    // Filter out pools that are not used in arb paths
    pools = {};
    for (let path of paths) {
        if (!path.shouldBlacklist(blacklistTokens)) {
            pools[path.pool1.address] = path.pool1;
            pools[path.pool2.address] = path.pool2;
            pools[path.pool3.address] = path.pool3;
        }
    }
    logger.info(`New pool count: ${Object.keys(pools).length}`);

    let s = new Date();
    let reserves = await batchGetUniswapV2Reserves(HTTPS_URL, Object.keys(pools));
    let e = new Date();
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