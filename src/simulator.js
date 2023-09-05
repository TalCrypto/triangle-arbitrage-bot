const { logger } = require('./constants');

class UniswapV2Simulator {
    constructor() {}

    reservesToPrice(
        reserve0,
        reserve1,
        decimals0,
        decimals1,
        token0In
    ) {
        reserve0 = Number(reserve0);
        reserve1 = Number(reserve1);
        decimals0 = Number(decimals0);
        decimals1 = Number(decimals1);

        let price = (reserve1 / reserve0) * 10 ** (decimals0 - decimals1);
        return token0In ? price : 1 / price;
    }

    getAmountOut(
        amountIn,
        reserveIn,
        reserveOut,
        fee
    ) {
        amountIn = BigInt(amountIn);
        reserveIn = BigInt(reserveIn);
        reserveOut = BigInt(reserveOut);
        fee = BigInt(fee);

        fee = fee / BigInt(100);
        let amountInWithFee = amountIn * (BigInt(1000) - fee);
        let numerator = amountInWithFee * reserveOut;
        let denominator = (reserveIn * BigInt(1000)) + amountInWithFee;
        return denominator == 0 ? 0 : Number(numerator / denominator);
    }
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

// Get sqrtPriceX96 at a specified tick.
function getSqrtPriceX96AtTick(tick) {
    // return sqrtBigInt(2**192 * (1.0001**tick));
    
    // Seems to work with floats. Beware of precision errors.
    return BigInt(Math.floor(Math.sqrt((2**192)*(1.0001**tick))));
}


// Get the output amount of a swap given an input amount.
function exactTokensOut(amountIn, pool, zfo) {
    // Calculations are performed in floats. For crafting transactions, calculations will need to be more precise.
    const inAfterFees = amountIn * BigInt(10000 - pool.extra.fee);
    let amountOut;

    if (pool.version == 2) {
        // Calculate the amount of output tokens for Uniswap V2.
        let reserveIn, reserveOut;
        if (zfo) {
            reserveIn = pool.extra.reserve0;
            reserveOut = pool.extra.reserve1;
        } else {
            reserveIn = pool.extra.reserve1;
            reserveOut = pool.extra.reserve0;
        }
        amountOut = (inAfterFees * reserveOut) / (BigInt(10000) * reserveIn + inAfterFees);

    } else if (pool.version == 3) {
        // Calculate for Uniswap V3.
        let sqrtPriceX96 = pool.extra.sqrtPriceX96;
        let liquidity = pool.extra.liquidity;
        let q96 = BigInt(2) ** BigInt(96);

        let tickSpacing = pool.extra.tickSpacing;
        let floatCurrentTick = (Math.log2(Number(sqrtPriceX96))-96) / Math.log2(Math.sqrt(1.0001));

        let currentTick = Math.floor(Math.round(floatCurrentTick*1000)/1000);

        if (zfo) {
            // If zeroForOne is True, the swap makes sqrtPrice smaller.
            let sqrtPricePrimeX96 = liquidity * sqrtPriceX96 * q96 * BigInt(10000) / (BigInt(10000) * q96 * liquidity + inAfterFees * sqrtPriceX96);

            // Find the sqrtPrice to the tick right under the current sqrtPrice.
            let tickLower = Math.floor(currentTick/tickSpacing) * tickSpacing;
            
            // If floatCurrentTick is within 1e-3 of a tick, return 0 output (rounding error risk).
            if (Math.abs(floatCurrentTick - tickLower) < 1e-3) {
                return 0n;
            }

            // Compute the sqrtPrice corresponding to the tick.
            let sqrtPriceLowerX96 = getSqrtPriceX96AtTick(tickLower);

            if (sqrtPricePrimeX96 < sqrtPriceLowerX96) {
                // If the new sqrtPrice is smaller than the tick, the swap will be at the tick.
                sqrtPricePrimeX96 = sqrtPriceLowerX96;
            }

            let spax = sqrtPricePrimeX96;
            let spbx = sqrtPriceX96;
            amountOut = liquidity * (spbx - spax) / q96;
        } else {
            // If zeroForOne is False, the swap makes sqrtPrice larger.
            let sqrtPricePrimeX96 = sqrtPriceX96 + q96 * inAfterFees / (liquidity * BigInt(10000));

            // Find the sqrtPrice to the tick right above the current sqrtPrice.
            let tickUpper = (1 + Math.floor(currentTick/tickSpacing)) * tickSpacing;

            // If floatCurrentTick is within 1e-3 of a tick, return 0 output (rounding error risk).
            if (Math.abs(floatCurrentTick - tickUpper) < 1e-3) {
                return 0n;
            }

            // Compute the sqrtPrice corresponding to the tick.
            let sqrtPriceUpperX96 = getSqrtPriceX96AtTick(tickUpper);

            if (sqrtPricePrimeX96 > sqrtPriceUpperX96) {
                // If the new sqrtPrice is larger than the tick, the swap will be at the tick.
                sqrtPricePrimeX96 = sqrtPriceUpperX96;
            }

            let spax = sqrtPriceX96;
            let spbx = sqrtPricePrimeX96;
            amountOut = liquidity * q96 * (spbx - spax) / spax / spbx;
        }
    }

    return amountOut;
}



module.exports = {
    UniswapV2Simulator,
};