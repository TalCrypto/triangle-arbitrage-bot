const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const cliProgress = require('cli-progress');

const { logger, CACHED_POOLS_FILE } = require('./constants');

const Erc20Abi = [
    'function decimals() external view returns (uint8)'
];

const V2FactoryAbi = [
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)'
];

const V3FactoryAbi = [
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
];

const DexVariant = {
    UniswapV2: 2,
    UniswapV3: 3,
};

class Pool {
    constructor(
        address,
        version,
        token0,
        token1,
        extra,
    ) {
        this.address = address;
        this.version = version;
        this.token0 = token0;
        this.token1 = token1;
        this.extra = extra;
    }

    cacheRow() {
        return [
            this.address,
            this.version,
            this.token0,
            this.token1,
            this.extra,
        ];
    }
}

const range = (start, stop, step) => {
    let loopCnt = Math.ceil((stop - start) / step);
    let rangeArray = [];
    for (let i = 0; i < loopCnt; i++) {
        let fromBlock = start + (i * step);
        let toBlock = Math.min(fromBlock + step, stop);
        rangeArray.push([fromBlock, toBlock]);
    }
    return rangeArray;
}

function loadCachedPools() {
    let cacheFile = path.join(__dirname, '..', CACHED_POOLS_FILE);
    let pools = {}
    if (fs.existsSync(cacheFile)) {
        const content = fs.readFileSync(cacheFile, 'utf-8');
        const rows = content.split('\n');
        for (let row of rows) {
            if (row == '') continue;
            row = row.split(',');
            if (row[0] == 'address') continue;
            let version = row[1] == '2' ? DexVariant.UniswapV2 : DexVariant.UniswapV3;
            let pool = new Pool(row[0],
                                version,
                                row[2],
                                row[3],
                                parseInt(row[4]),
                                parseInt(row[5]),
                                parseInt(row[6]))
            pools[row[0]] = pool;
        }
    }
    return pools;
}

function cacheSyncedPools(pools) {
    const columns = ['address', 'version', 'token0', 'token1', 'decimals0', 'decimals1', 'fee'];
    let data = columns.join(',') + '\n';
    for (let address in pools) {
        let pool = pools[address];
        let row = pool.cacheRow().join(',') + '\n';
        data += row;
    }
    let cacheFile = path.join(__dirname, '..', CACHED_POOLS_FILE);
    fs.writeFileSync(cacheFile, data, { encoding: 'utf-8' });
}


// Use 'getEventsRecursive' to get all the events from a contract.
async function loadAllPoolsFromV2(provider, factoryAddresses) {
    // let pools = loadCachedPools();
    // if (Object.keys(pools).length > 0) {
    //     return pools;
    // }
    const toBlock = await provider.getBlockNumber();

    pools = {};
    for (let i = 0; i < factoryAddresses.length; i++) {
        // Use more efficient method to get events
        const factoryAddress = factoryAddresses[i];
        const factoryContract = new ethers.Contract(factoryAddress, V2FactoryAbi, provider);
        const eventFilter = factoryContract.filters.PairCreated();
        const iface = new ethers.utils.Interface(V2FactoryAbi);
        const events = await getEventsRecursive(provider, eventFilter, iface, 0, toBlock);
        
        for (let event of events) {
            let token0 = event.args[0];
            let token1 = event.args[1];

            // Do not use decimals for now
            let pool = new Pool(event.args[2],
                DexVariant.UniswapV2,
                token0,
                token1,
                {fee: 300});
            pools[event.args[2]] = pool;
        }
    }

    // cacheSyncedPools(pools);
    return pools;
}

// Returns the list of pools created by a v3-compatible factory contract.
async function loadAllPoolsFromV3(provider, factoryAddresses) {
    const toBlock = await provider.getBlockNumber();

    pools = {};
    for (let i = 0; i < factoryAddresses.length; i++) {
        // Use more efficient method to get events
        const factoryAddress = factoryAddresses[i];
        const factoryContract = new ethers.Contract(factoryAddress, V3FactoryAbi, provider);
        const eventFilter = factoryContract.filters.PoolCreated();
        const iface = new ethers.utils.Interface(V3FactoryAbi);
        const events = await getEventsRecursive(provider, eventFilter, iface, 0, toBlock);

        for (let event of events) {
            // event.args = [token0, token1, fee, tickSpacing, pool]
            let token0 = event.args[0];
            let token1 = event.args[1];

            // Do not use decimals for now
            let pool = new Pool(event.args[4], // pool address
                DexVariant.UniswapV3,
                token0,
                token1,
                {
                    fee: event.args[2], // fee
                    tickSpacing: event.args[3], // tickSpacing
                });
            pools[event.args[4]] = pool; // pool address
        }
    }

    return pools;
}

// Get events from a contract recursively. If there is an error, split the block range in half and try again.
async function getEventsRecursive(provider, eventFilter, iface, fromBlock, toBlock) {
    // Node providers typically limit to 10k events per request.
    //
    // eventFilter: ethers.Contract.filters object
    // fromBlock: int
    // toBlock: int
    //
    // returns: array of events
    
    try {
        let events = await provider.getLogs({
            address: eventFilter.address,
            fromBlock: fromBlock,
            toBlock: toBlock,
            topics: eventFilter.topics,
        });
        // console.log(`Found ${events.length} events from ${fromBlock} to ${toBlock}`);
        events = events.map((event) => {
            return iface.parseLog(event);
        });
        return events;
    } catch (e) {
        // console.log("Too many events, splitting block range in half");
        let midBlock = Math.floor((fromBlock + toBlock) / 2);

        let events1 = await getEventsRecursive(provider, eventFilter, iface, fromBlock, midBlock);
        let events2 = await getEventsRecursive(provider, eventFilter, iface, midBlock + 1, toBlock);
        return events1.concat(events2);
    }
}

// Returns a list containing the pools found in the given paths.
function poolsFromPaths(paths){
    let pools = {};
    for (let path of paths) {
        for (let pool of path.pools) {
            pools[pool.address] = pool;
        }
    }
    return pools;
}

module.exports = {
    loadAllPoolsFromV2,
    loadAllPoolsFromV3,
    poolsFromPaths,
};