const cliProgress = require('cli-progress');
const { logger } = require('./constants');
const { UniswapV2Simulator } = require('./simulator');

const range = (start, stop, step) => {
    let loopCnt = Math.ceil((stop - start) / step);
    let rangeArray = [];
    for (let i = 0; i < loopCnt; i++) {
        let num = start + (i * step);
        rangeArray.push(num);
    }
    return rangeArray;
}

class ArbPath {
    constructor(
        root, // root token, token from which the arbitrage path starts
        pools, // pool1, pool2, pool3; The pools involved in the arbitrage path
        directions, // zeroForOne1, zeroForOne2, ...; Indicates the direction of each swap. zfo = true means token0 -> token1.
    ) {
        this.root = root;
        this.pools = pools;
        this.directions = directions;
    }

    nhop() {
        return this.pool3 === undefined ? 2 : 3;
    }

    hasPool(pool) {
        let isPool1 = this.pool1.address.toLowerCase() == pool.toLowerCase();
        let isPool2 = this.pool2.address.toLowerCase() == pool.toLowerCase();
        let isPool3 = this.pool3.address.toLowerCase() == pool.toLowerCase();
        return isPool1 || isPool2 || isPool3;
    }

    shouldBlacklist(blacklistTokens) {
        for (let i = 0; i < this.nhop(); i++) {
            let pool = this[`pool${i + 1}`];
            if ((pool.token0 in blacklistTokens) || (pool.token1 in blacklistTokens)) {
                return true;
            }
            return false;
        }
    }

    simulateV2Path(amountIn, reserves) {
        let tokenInDecimals = this.zeroForOne1 ? this.pool1.decimals0 : this.pool1.decimals1;
        let amountOut = amountIn * 10 ** tokenInDecimals;

        let sim = new UniswapV2Simulator();
        let nhop = this.nhop();
        for (let i = 0; i < nhop; i++) {
            let pool = this[`pool${i + 1}`];
            let zeroForOne = this[`zeroForOne${i + 1}`];
            let reserve0 = reserves[pool.address][0];
            let reserve1 = reserves[pool.address][1];
            let fee = pool.fee;
            let reserveIn = zeroForOne ? reserve0 : reserve1;
            let reserveOut = zeroForOne ? reserve1 : reserve0;
            amountOut = sim.getAmountOut(amountOut, reserveIn, reserveOut, fee);
        }
        return amountOut;
    }

    optimizeAmountIn(maxAmountIn, stepSize, reserves) {
        let tokenInDecimals = this.zeroForOne1 ? this.pool1.decimals0 : this.pool1.decimals1;
        let optimizedIn = 0;
        let profit = 0;
        for (let amountIn of range(0, maxAmountIn, stepSize)) {
            let amountOut = this.simulateV2Path(amountIn, reserves);
            let thisProfit = amountOut - (amountIn * (10 ** tokenInDecimals));
            if (thisProfit >= profit) {
                optimizedIn = amountIn;
                profit = thisProfit;
            } else {
                break;
            }
        }
        return [optimizedIn, profit / (10 ** tokenInDecimals)];
    }
}


function generateTriangularPaths(pools, tokenIn) {
    /*
    This can easily be refactored into a recursive function to support the
    generation of n-hop paths. However, I left it as a 3-hop path generating function
    just for demonstration. This will be easier to follow along.

    👉 The recursive version can be found here (Python):
    https://github.com/solidquant/whack-a-mole/blob/main/data/dex.py
    */
    const paths = [];

    pools = Object.values(pools);

    const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progress.start(pools.length);

    for (let i = 0; i < pools.length; i++) {
        let pool1 = pools[i];
        let canTrade1 = (pool1.token0 == tokenIn) || (pool1.token1 == tokenIn);
        if (canTrade1) {
            let zeroForOne1 = pool1.token0 == tokenIn;
            let tokenOut1 = zeroForOne1 ? pool1.token1 : pool1.token0;

            for (let j = 0; j < pools.length; j++) {
                let pool2 = pools[j];
                let canTrade2 = (pool2.token0 == tokenOut1) || (pool2.token1 == tokenOut1);
                if (canTrade2) {
                    let zeroForOne2 = pool2.token0 == tokenOut1;
                    let tokenOut2 = zeroForOne2 ? pool2.token1 : pool2.token0;

                    for (let k = 0; k < pools.length; k++) {
                        let pool3 = pools[k];
                        let canTrade3 = (pool3.token0 == tokenOut2) || (pool3.token1 == tokenOut2);
                        if (canTrade3) {
                            let zeroForOne3 = pool3.token0 == tokenOut2;
                            let tokenOut3 = zeroForOne3 ? pool3.token1 : pool3.token0;

                            if (tokenOut3 == tokenIn) {
                                let uniquePoolCnt = [...new Set([
                                    pool1.address,
                                    pool2.address,
                                    pool3.address,
                                ])].length;

                                if (uniquePoolCnt < 3) {
                                    continue;
                                }

                                let arbPath = new ArbPath(pool1,
                                                          pool2,
                                                          pool3,
                                                          zeroForOne1,
                                                          zeroForOne2,
                                                          zeroForOne3);
                                paths.push(arbPath);
                            }
                        }
                    }
                }
            }
        }
        progress.update(i + 1);
    }

    progress.stop();
    logger.info(`Generated ${paths.length} 3-hop arbitrage paths`);
    return paths;
}


function generatePaths(rootTokens, pools, maxHops) {
    // Stores all temporary paths
    const tempPoolPaths = []; // [[pool1, pool2, ...., poolN], ...]

    // Store the input token for the next hop of each path
    const tempOutTokens = []; // [outTokenForPath1, outTokenForPath2, ...]
    
    const finalPaths = [];

    // Lookup table to retrieve pools by token involved
    const tokenToPools = {}; // {token1: [pool1, pool2, ...], token2: [pool1, pool2, ...], ...}

    // Build the lookup table. pools is not iterable.
    for (let pool of Object.values(pools)) {
        if (!(pool.token0 in tokenToPools)) {
            tokenToPools[pool.token0] = [];
        }
        if (!(pool.token1 in tokenToPools)) {
            tokenToPools[pool.token1] = [];
        }
        tokenToPools[pool.token0].push(pool);
        tokenToPools[pool.token1].push(pool);
    }

    // Define recursive function to generate paths
    function generatePathsRecursive(tokenIn, path, stopToken, hop) {
        // If the current hop is the last hop, we should stop here
        if (hop == maxHops) {
            return;
        }

        // Get all pools that involve the input token
        let potentialPools = tokenToPools[tokenIn];

        // Check if the potential pools are already in the path by comparing addresses
        let futurePools = potentialPools.filter(pool => {
            return !path.some(pathPool => {
                return pathPool.address == pool.address;
            });
        });

        // If there are no more pools to explore, we should stop here
        if (futurePools.length == 0) {
            return;
        }

        // For each pool, we should explore the next hop
        for (let pool of futurePools) {
            // Get the output token for the next hop
            let tokenOut = pool.token0 == tokenIn ? pool.token1 : pool.token0;

            // If the output token is the stop token, we should add the path to the final paths
            let futurePath = [...path, pool];
            if (tokenOut == stopToken) {
                finalPaths.push({
                    pools: futurePath,
                    rootToken: stopToken,
                });
            } else {
                // Otherwise, we should explore the next hop
                generatePathsRecursive(tokenOut, futurePath, stopToken, hop + 1);
            }
        }
    }

    // Use the recursive function to generate paths for each root token
    let pathCount = 0;
    for (let rootToken of rootTokens) {
        generatePathsRecursive(rootToken, [], rootToken, 0);
        logger.info(`Generated ${finalPaths.length - pathCount} paths for ${rootToken}`);
        pathCount = finalPaths.length;
    }

    // Add the zeroForOne array to the final path objects
    for (let path of finalPaths) {
        let zeroForOne = [];

        // Set the first zfo with respect to the root token
        zeroForOne.push(path.pools[0].token0 == path.rootToken);
        let inToken = zeroForOne[0] ? path.pools[0].token0 : path.pools[0].token1;

        // Set the rest of the zfo with respect to the previous pool
        for (let i = 1; i < path.pools.length; i++) {
            zeroForOne.push(path.pools[i].token0 == inToken);
            inToken = zeroForOne[i] ? path.pools[i].token0 : path.pools[i].token1;
        }

        path.directions = zeroForOne;
    }

    return finalPaths;
}


module.exports = {
    ArbPath,
    generateTriangularPaths,
    generatePaths,
};