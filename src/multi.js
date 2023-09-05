const { ethers } = require('ethers');

const UniswapV2PairAbi = require('../abi/UniswapV2Pair.json');
const FlashQueryV3Abi = require('../abi/FlashQueryV3.json');

const {
    MULTICALL_ADDRESS,
    MULTICALL_ABI,
    FLASH_QUERY_V3_ADDRESS,
    logger,
} = require('./constants');

async function getUniswapV2Reserves(provider, poolAddresses, pools) {
    // 👉 Example of multicall provided: https://github.com/mds1/multicall/tree/main/examples/typescript
    const v2PairInterface = new ethers.utils.Interface(UniswapV2PairAbi);
    const calls = poolAddresses.map(address => ({
        target: address,
        allowFailure: true,
        callData: v2PairInterface.encodeFunctionData('getReserves', []),  // 0x0902f1ac
    }));
    
    logger.info(`Performing V2 multicall for ${poolAddresses.length} pools.`);
    const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
    const result = await multicall.callStatic.aggregate3(calls);

    for (let i = 0; i < result.length; i++) {
        let response = result[i];
        if (response.success) {
            let decoded = v2PairInterface.decodeFunctionResult('getReserves', response.returnData);
            pools[poolAddresses[i]].extra.reserve0 = BigInt(decoded[0]);
            pools[poolAddresses[i]].extra.reserve1 = BigInt(decoded[1]);
        }
    }
}


// Use FlashQueryV3 contract to pull liquidity/sqrtPrice from v3 pools.
async function getUniswapV3Liquidity(provider, poolAddresses, pools) {
    const flashQuery = new ethers.Contract(FLASH_QUERY_V3_ADDRESS, FlashQueryV3Abi, provider);
    
    logger.info(`Performing V3 multicall for ${poolAddresses.length} pools.`);
    const result = await flashQuery.callStatic.getLiquidityV3(poolAddresses);

    // Result is two arrays, one for sqrtPrice and one for liquidity.
    let sqrtPriceList = result[0];
    let liquidityList = result[1];

    for (let i = 0; i < poolAddresses.length; i++) {
        pools[poolAddresses[i]].extra.sqrtPriceX96 = BigInt(sqrtPriceList[i]);
        pools[poolAddresses[i]].extra.liquidity = BigInt(liquidityList[i]);
    }
}


// Fetch reserves for a list of pools. Fetch separately for v2 and v3 pools.
async function batchReserves(provider, pools, onlyAddresses = [], batchSize = 100, callPerSecond = 0) {
    // Requests must be batched to avoid hitting the max request size, and to get the best performance.
    // onlyAddresses is an optional parameter that can be used to limit the batch to a subset of pools.

    let v2Addresses
    let v3Addresses
    if (onlyAddresses.length > 0) {
        // Addresses in onlyAddresses may not be in the pools object, care must be taken.
        v2Addresses = onlyAddresses.filter(address => pools[address] && pools[address].version === 2);
        v3Addresses = onlyAddresses.filter(address => pools[address] && pools[address].version === 3);
    } else {
        v2Addresses = Object.keys(pools).filter(address => pools[address].version === 2);
        v3Addresses = Object.keys(pools).filter(address => pools[address].version === 3);
    }
    logger.info(`Fetching reserves for ${v2Addresses.length} v2 pools and ${v3Addresses.length} v3 pools.`);
    const promises = [];

    // Build batches of addresses and return promises for each batch.
    if (v2Addresses.length > 0) {
        const v2Batches = [];
        for (let i = 0; i < v2Addresses.length; i += batchSize) {
            // Start calling the batches.
            promises.push(getUniswapV2Reserves(provider, toFetch, pools));
        }
        promises.push(...v2Batches.map(batch => getUniswapV2Reserves(httpsUrl, batch, pools)));
    }

    if (v3Addresses.length > 0) {
        const v3Batches = [];
        for (let i = 0; i < v3Addresses.length; i += batchSize) {

            // Start calling the batches.
            promises.push(getUniswapV3Liquidity(provider, toFetch, pools));
        }
        promises.push(...v3Batches.map(batch => getUniswapV3Liquidity(httpsUrl, batch, pools)));
    }

    // Resolve all promises at once.
    const results = await Promise.all(promises);
}


module.exports = {
    getUniswapV2Reserves,
    getUniswapV3Liquidity,
    batchReserves,
};