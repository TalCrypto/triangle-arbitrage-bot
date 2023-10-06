const { logger } = require('./constants');
const { sqrtBigInt } = require('./utils');

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


// Port original Solidity code from Uniswap V3-core (TickMath.sol).
function getSqrtRatioAtTick(tick) {
    let absTick = Math.abs(tick);
    if (absTick > 887272) {
        throw new Error('T: Price is out of bounds');
    }

    let ratio = (absTick & 0x1) != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
    if ((absTick & 0x2) != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
    if ((absTick & 0x4) != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
    if ((absTick & 0x8) != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
    if ((absTick & 0x10) != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
    if ((absTick & 0x20) != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
    if ((absTick & 0x40) != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
    if ((absTick & 0x80) != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
    if ((absTick & 0x100) != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
    if ((absTick & 0x200) != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
    if ((absTick & 0x400) != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
    if ((absTick & 0x800) != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
    if ((absTick & 0x1000) != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
    if ((absTick & 0x2000) != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
    if ((absTick & 0x4000) != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
    if ((absTick & 0x8000) != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
    if ((absTick & 0x10000) != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
    if ((absTick & 0x20000) != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
    if ((absTick & 0x40000) != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
    if ((absTick & 0x80000) != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
    let maxInt = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
    if (tick > 0) ratio = maxInt / ratio;

    // this divides by 1<<32 rounding up to go from a Q128.128 to a Q128.96.
    // we then downcast because we know the result always fits within 160 bits due to our tick input constraint
    // we round up in the division so getTickAtSqrtRatio of the output price is always consistent
    sqrtPriceX96 = (ratio >> 32n) + (ratio % (1n << 32n) == 0 ? 0n : 1n);
    return sqrtPriceX96;
}

// Get the current tick from the sqrtPriceX96 (greatest integer for which the ratio is less than or equal to sqrtPriceX96).
function getTickAtSqrtRatio(sqrtPriceX96) {
    // First, we know that sqrtPriceX96 = sqrt(1.0001**tick) * 2**96.
    // So sqrtPriceX96 / 2**96 = sqrt(1.0001**tick)
    // (sqrtPriceX96 / 2**96)**2 = 1.0001**tick
    // Take the log2 of both sides, we get log2((sqrtPriceX96 / 2**96)**2) = log2(1.0001**tick)
    // It follows that 2*log2(sqrtPriceX96 / 2**96) = tick * log2(1.0001)
    // tick = 2*log2(sqrtPriceX96 / 2**96) / log2(1.0001)
    // tick = 2*(log2(sqrtPriceX96) - 96) / log2(1.0001)

    let tick = 2 * (Math.log2(Number(sqrtPriceX96)) - 96) / Math.log2(1.0001);
    tick = Math.floor(tick);

    if (tick < -887272 || tick > 887272) {
        throw new Error('T: Price is out of bounds');
    }

    return tick;
    
    // let floatCurrentTick = (Math.log2(Number(sqrtPriceX96))-96) / Math.log2(Math.sqrt(1.0001));
    // return Math.floor(tick);
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
        amountOut = (inAfterFees * reserveOut) / (10000n * reserveIn + inAfterFees);

    } else if (pool.version == 3) {
        // Calculate for Uniswap V3.
        let sqrtPriceX96 = pool.extra.sqrtPriceX96;
        let liquidity = pool.extra.liquidity;
        let q96 = 2n ** 96n;
        let tickSpacing = pool.extra.tickSpacing;
        let currentTick = getTickAtSqrtRatio(sqrtPriceX96);

        try {
            if (zfo) {
                // If zeroForOne is True, the swap makes sqrtPrice smaller.
                let sqrtPricePrimeX96 = liquidity * sqrtPriceX96 * q96 * BigInt(10000) / (BigInt(10000) * q96 * liquidity + inAfterFees * sqrtPriceX96);

                // Find the sqrtPrice to the tick right under the current sqrtPrice.
                let tickLower = Math.floor(currentTick/tickSpacing) * tickSpacing;

                // Compute the sqrtPrice corresponding to the tick.
                let sqrtPriceLowerX96 = getSqrtRatioAtTick(tickLower);

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

                // Compute the sqrtPrice corresponding to the tick.
                let sqrtPriceUpperX96 = getSqrtRatioAtTick(tickUpper);

                if (sqrtPricePrimeX96 > sqrtPriceUpperX96) {
                    // If the new sqrtPrice is larger than the tick, the swap will be at the tick.
                    sqrtPricePrimeX96 = sqrtPriceUpperX96;
                }

                let spax = sqrtPriceX96;
                let spbx = sqrtPricePrimeX96;
                amountOut = liquidity * q96 * (spbx - spax) / spax / spbx;
            }
        } catch (e) {
            logger.error(`DEBUG: Error in Uniswap V3 math: ${e}`);
            console.log("amountIn: ", amountIn);
            console.log("pool: ", pool);
            console.log("zfo: ", zfo);
            amountOut = 0n;
        }
    }

    return amountOut;
}

// Compute the profit of an arbitrage path given an input amount.
function computeProfit(amountIn, path) {

    let amountOut = amountIn;
    for (let i = 0; i < path.pools.length; i++) {
        let pool = path.pools[i];
        let zfo = path.directions[i];
        amountOut = exactTokensOut(amountOut, pool, zfo);
    }
    return amountOut - amountIn;
}

// Find the optimal input amount for an arbitrage path.
function optimizeAmountIn(path) {
    // To find the local maximum, we calculate the derivative of the profit function at the middle point of the interval. Assume the profit function is convex.
    let min = BigInt(1000);
    let max = BigInt(10 ** 30); // = 2**100
    let stepsMax = 100;

    // Use whichever is larger.
    let alpha = 1e-6; // relative step size
    let beta = 100; // absolute step size

    // Test, needs improvement.
    function h(x) {
        return BigInt(Math.floor(Math.max(alpha * Number(x), beta)));
    }

    // Compute the profit and the derivative at the minimum.
    let minProfit = computeProfit(min, path);
    let minDerivative = computeProfit(min + h(min), path) - minProfit;

    if (minDerivative < 0n) {
        // If the profit is negative and the derivative is negative, the maximum is at the minimum.
        return min;
    } 

    // When the derivative at middle point is positive, we know the maximum is in the interval [mid, max]. The same applies to the reverse direction.
    let mid;
    let midDerivative;
    for (let i = 0; i < stepsMax; i++) {
        mid = (min + max) / BigInt(2);
        midProfit = computeProfit(mid, path);
        midDerivative = computeProfit(mid + h(mid), path) - midProfit;

        if (midDerivative > 0) {
            min = mid;
        } else {
            max = mid;
        }
    }

    return mid;
}

module.exports = {
    UniswapV2Simulator,
    exactTokensOut,
    computeProfit,
    optimizeAmountIn,
};
