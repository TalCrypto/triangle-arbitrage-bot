const { ethers } = require('ethers');
const axios = require('axios');

const { 
    BLOCKNATIVE_TOKEN,
    CHAIN_ID,
} = require('./constants');

const calculateNextBlockBaseFee = (block) => {
    let baseFee = BigInt(block.baseFeePerGas);
    let gasUsed = BigInt(block.gasUsed);
    let gasLimit = BigInt(block.gasLimit);

    let targetGasUsed = gasLimit / BigInt(2);
    targetGasUsed = targetGasUsed == BigInt(0) ? BigInt(1) : targetGasUsed;

    let newBaseFee;

    if (gasUsed > targetGasUsed) {
        newBaseFee = baseFee + ((baseFee * (gasUsed - targetGasUsed)) / targetGasUsed) / BigInt(8);
    } else {
        newBaseFee = baseFee - ((baseFee * (targetGasUsed - gasUsed)) / targetGasUsed) / BigInt(8);
    }

    const rand = BigInt(Math.floor(Math.random() * 10));
    return newBaseFee + rand;
};

async function estimateNextBlockGas() {
    let estimate = {};
    if (!BLOCKNATIVE_TOKEN || ![1, 137].includes(parseInt(CHAIN_ID))) return estimate;
    const url = `https://api.blocknative.com/gasprices/blockprices?chainid=${CHAIN_ID}`;
    const response = await axios.get(url, {
        headers: { Authorization: BLOCKNATIVE_TOKEN },
    });
    if (response.data) {
        let gwei = 10 ** 9;
        let res = response.data;
        let estimatedPrice = res.blockPrices[0].estimatedPrices[0];
        estimate['maxPriorityFeePerGas'] = BigInt(parseInt(estimatedPrice['maxPriorityFeePerGas'] * gwei));
        estimate['maxFeePerGas'] = BigInt(parseInt(estimatedPrice['maxFeePerGas'] * gwei));
    }
    return estimate;
}

// Find pools that were probably updated in the given block
async function findUpdatedPools(provider, blockNumber) {
    // Selectors for events that update reserves in a Uniswap V2/V3 pool
    const eventSelectors = {
        V2Sync: ethers.utils.id('Sync(uint112,uint112)'), // [uint112 reserve0, uint112 reserve1]
        V3Mint: ethers.utils.id('Mint(address,address,int24,int24,uint128,uint256,uint256)'), // [address sender, address owner, int24 tickLower, int24 tickUpper, uint128 amount, uint128 amount0, uint128 amount1]
        V3Burn: ethers.utils.id('Burn(address,address,int24,int24,uint128,uint256,uint256)'), // [address sender, address owner, int24 tickLower, int24 tickUpper, uint128 amount, uint128 amount0, uint128 amount1]
        V3Swap: ethers.utils.id('Swap(address,address,int256,int256,uint160,uint128,int24)'), // [address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick]
        V3Collect: ethers.utils.id('Collect(address,int24,int24,uint128,uint128)'), // [address sender, int24 tickLower, int24 tickUpper, uint128 amount0, uint128 amount1]
        V3Flash: ethers.utils.id('Flash(address,address,uint256,uint256,uint256,uint256)'), // [address sender, address recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1]
    }

    const filters = [];
    for (const [key, value] of Object.entries(eventSelectors)) {
        filters.push({
            fromBlock: blockNumber,
            toBlock: blockNumber,
            topics: [value],
        });
    }

    // Use promise.all to get all logs in parallel for each filter
    let filterLogs = await Promise.all(filters.map(filter => provider.getLogs(filter)));
    
    // Get unique pool addresses from logs
    let logCount = 0;
    let poolAddresses = [];
    for (const logs of filterLogs) {
        for (const log of logs) {
            console.log(log);
            poolAddresses.push(log.address);
            logCount++;
        }
    }
    console.log(`Found ${logCount} logs in block ${blockNumber}`);

    // Remove duplicates
    poolAddresses = [...new Set(poolAddresses)];
    
    return poolAddresses;
}


module.exports = {
    calculateNextBlockBaseFee,
    estimateNextBlockGas,
    findUpdatedPools,
};