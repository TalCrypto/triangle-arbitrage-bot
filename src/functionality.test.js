const {optimizeAmountIn, computeProfit} = require('./simulator');
const {expect} = require('@jest/globals');

const temp_path = {
    pools: [
        {
          address: '0x5B27BFe67b1Afb4742bb56dFad88759BAdC03b17',
          version: 2,
          token0: '0x7Ecb5699D8E0a6572E549Dc86dDe5A785B8c29BC',
          token1: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
          extra: {
            fee: 30,
            reserve0: 7552820592132233235317871n,
            reserve1: 38273678n,
            liquidity: 17002182899117349n
          }
        },
        {
          address: '0x4152ea409F10F7d6efDCa92149fDE430A8712b02',
          version: 2,
          token0: '0x7Ecb5699D8E0a6572E549Dc86dDe5A785B8c29BC',
          token1: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
          extra: {
            fee: 30,
            reserve0: 17014805899402530504698201n,
            reserve1: 87623139n,
            liquidity: 38612053848265672n
          }
        }
      ],
      rootToken: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      directions: [ false, true ]
}



test('Should be calculate the optimized amount', ()=>{
    const amountIn = optimizeAmountIn(temp_path);
    const amountPIn = amountIn + BigInt(1000000);
    const amountMIn = amountIn - BigInt(1000000);
    const profitwei = computeProfit(amountIn, temp_path);
    const profitPwei = computeProfit(amountPIn, temp_path);
    const profitMwei = computeProfit(amountMIn, temp_path);
    expect(profitwei).toBeGreaterThanOrEqual(profitMwei);
    expect(profitwei).toBeGreaterThanOrEqual(profitPwei);
})

test('Should be calculate the optimized amount for a triangle', () => {
    const alt_temp_path = getTempPath();
    const amountIn = optimizeAmountIn(alt_temp_path);
    const amountPIn = amountIn + BigInt(1); //1, 100 and 1000 work, but 1,000,000 doesn't
    const amountMIn = amountIn - BigInt(1); //1, 100 and 1000 work, but 1,000,000 doesn't
    const profitwei = computeProfit(amountIn, alt_temp_path);
    const profitPwei = computeProfit(amountPIn, alt_temp_path);
    const profitMwei = computeProfit(amountMIn, alt_temp_path);
    expect(profitwei).toBeGreaterThanOrEqual(profitMwei);
    expect(profitwei).toBeGreaterThanOrEqual(profitPwei);
})

test('Should be calculate the optimized amount for a triangle with bigger diff', () => {
    const alt_temp_path = getTempPath();
    const amountIn = optimizeAmountIn(alt_temp_path);
    const amountPIn = amountIn + BigInt(100); //1, 100 and 1000 work, but 1,000,000 doesn't
    const amountMIn = amountIn - BigInt(100); //1, 100 and 1000 work, but 1,000,000 doesn't
    const profitwei = computeProfit(amountIn, alt_temp_path);
    const profitPwei = computeProfit(amountPIn, alt_temp_path);
    const profitMwei = computeProfit(amountMIn, alt_temp_path);
    expect(profitwei).toBeGreaterThanOrEqual(profitMwei);
    expect(profitwei).toBeGreaterThanOrEqual(profitPwei);
})



function getTempPath() {
  return {
      pools: [
      {
        address: '0x45dDa9cb7c25131DF268515131f647d726f50608',
        version: 3,
        token0: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        token1: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        extra: {
          fee: 5,
          tickSpacing: 10,
          sqrtPriceX96: 1751139670790876746630698947283715n,
          liquidity: 1332782063782144328n
        }
      },
      {
        address: '0xD2923457569D4f0C4a52f6307b52ED344E31592B',
        version: 2,
        token0: '0x598e49f01bEfeB1753737934a5b11fea9119C796',
        token1: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        extra: {
          fee: 30,
          reserve0: 8598316919n,
          reserve1: 20377471792889n,
          liquidity: 418583277835n
        }
      },
      {
        address: '0x85ba262be13329A2Db5acf9Aa46aC2345b5DF4ff',
        version: 2,
        token0: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        token1: '0x598e49f01bEfeB1753737934a5b11fea9119C796',
        extra: {
          fee: 30,
          reserve0: 40100628512n,
          reserve1: 5560546840642866n,
          liquidity: 14932562512181n
        }
      }
    ],
    rootToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    directions: [ true, false, false ],
    liquidityProduct: 8330495668581890790789781404831022466169160n
    
  }
}