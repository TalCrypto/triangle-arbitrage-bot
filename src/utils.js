const { ethers } = require('ethers');
const axios = require('axios');

const { 
    BLOCKNATIVE_TOKEN,
    CHAIN_ID,
    logger,
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

// Find pools that were updated in the given block
async function findUpdatedPools(provider, blockNumber, pools) {
    // Interfaces for the events we are interested in.
    const interfaces = [
        new ethers.utils.Interface(['event Sync(uint112 reserve0, uint112 reserve1)']),
        new ethers.utils.Interface(['event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)']),
        new ethers.utils.Interface(['event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)']),
        new ethers.utils.Interface(['event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)']),
        // new ethers.utils.Interface(['event Flash(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)']),
        // new ethers.utils.Interface(['event Collect(address indexed sender, uint256 amount0, uint256 amount1)']),
    ];

    // Used to print the DEX version associated with each event.
    const interfaceVersion = {
        "Sync": "V2",
        "Mint": "V3",
        "Burn": "V3",
        "Swap": "V3",
        // "Flash": "V3",
        // "Collect": "V3",
    }

    const logPromises = [];
    const parsedResults = [];
    // For each filter, async get the logs, and parse them according to the ABI interface.
    for (let iface of interfaces) {
        // Initiate the promise
        let prom = provider.getLogs({
            fromBlock: blockNumber,
            toBlock: blockNumber,
            topics: [
                iface.getEventTopic(Object.values(iface.events)[0]),
            ],
        });

        // After the promise returns, parse the data.
        prom.then((logs) => {
            logger.info(`Found ${logs.length} logs for ${Object.values(iface.events)[0].name} (${interfaceVersion[Object.values(iface.events)[0].name]}) in block ${blockNumber}`);
            for (const log of logs) {
                parsedResults.push({
                    // Forward the raw log
                    log: log,
                    // Copy the interface object
                    interface: Object.assign({}, iface),
                    // Parse the log data
                    // parsed: iface.parseLog(log)
                });
            }
        });

        // Add the promise to the list.
        logPromises.push(prom);
    }

    // Wait for the promises to resolve
    await Promise.all(logPromises);
    
    // Get unique pool addresses from logs
    let logCount = 0;
    let poolAddresses = [];
    for (const resLog of parsedResults) {
        const iface = resLog.interface;
        const name = Object.values(iface.events)[0].name;
        logger.info(`Found event ${name} (${interfaceVersion[name]}) in block ${blockNumber}. Pool address: ${resLog.log.address}`);
        poolAddresses.push(resLog.log.address);

        // const logs = resLog.parsed.args;
        // Logs is array-like with some named members. Print only the named members. (both key and value).
        // for (const [key, value] of Object.entries(logs)) {
        //     if (isNaN(key)){
        //         logger.info(key, value);
        //     }
        // }
        
        logCount++;
    }
    logger.info(`Found ${logCount} DEX (V2, V3) logs in block ${blockNumber}`);

    // Ignore potential pools that are not already known (in the pools object).
    poolAddresses = [...new Set(poolAddresses)]; // Remove duplicates
    poolAddresses = poolAddresses.filter(poolAddress => pools[poolAddress]);
    logger.info(`Found ${poolAddresses.length} pools in block ${blockNumber}`);

    return poolAddresses;
}

// Get the square root of a BigInt.
function sqrtBigInt(n) {
    if (n < 0n) {
        throw 'Square root of negative numbers is not supported';
    }

    if (n < 2n) {
        return n;
    }

    function newtonIteration(n, x0) {
        const x1 = ((n / x0) + x0) >> 1n;
        if (x0 === x1 || x0 === (x1 - 1n)) {
            return x0;
        }
        return newtonIteration(n, x1);
    }

    return newtonIteration(n, 1n);
}

// Clip a number to a given decimal precision.
function clipBigInt(num, precision) {
    // Our Uniswap Math uses JS Number which can lack precision. This clips some amount of token.
    // The result should minimize our expected profit by a negligible amount.
    // This has the benefit of giving confident in the fact that our transactions will succeed.
    let numDecimals = num.toString().length - 1;

    let clipDecimals = numDecimals - precision;
    if (clipDecimals > 0) {
        return (num / BigInt(10 ** clipDecimals)) * BigInt(10 ** clipDecimals);
    } else {
        return num;
    }
}

// Display bot stats
function displayStats(sessionStart, logger, tokens, dataStore, profitStore){
    logger.info("===== Profit Recap =====")
    let sessionDuration = (new Date() - sessionStart) / 1000;
    logger.info(`Session duration: ${sessionDuration} seconds (${sessionDuration / 60} minutes) (${sessionDuration / 60 / 60} hours)`);
    
    // For each token, display the profit in decimals
    for (let token in profitStore) {
        let profit = Number(profitStore[token]) / 10**tokens[token].decimals;
        logger.info(`${tokens[token].symbol}: ${profit} $${profit*tokens[token].usd} (${token})`);
    }
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


module.exports = {
    calculateNextBlockBaseFee,
    estimateNextBlockGas,
    findUpdatedPools,
    sqrtBigInt,
    clipBigInt,
    displayStats,
};