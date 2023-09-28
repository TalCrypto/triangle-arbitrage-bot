// This script performs an arbitrage trade between 3 pools on a forked node.
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "forge-std/StdCheats.sol";

interface IUniswapV2Pair {
  function token0() external view returns (address);
  function token1() external view returns (address);

  function getReserves()
    external
    view
    returns (
      uint112 reserve0,
      uint112 reserve1,
      uint32 blockTimestampLast
    );

    function swap(
        uint amount0Out,
        uint amount1Out,
        address to,
        bytes calldata data
    ) external;
}

interface IUniswapV3Pool{
    function token0() external view returns (address);
    function token1() external view returns (address);
	function liquidity() external view returns (uint128);
	function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool);
    // slot() returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)
    function tickSpacing() external view returns (int24);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external;
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external;
}

contract Arbitrage is Script, StdCheats {

    // Display information about a Uniswap V2 pool
    function readV2(address pool) public view {
        (uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(pool).getReserves();

        console.log("= Uniswap V2 =");
        console.log("Pool: ", pool);
        console.log("Token0: ", IUniswapV2Pair(pool).token0());
        console.log("Token1: ", IUniswapV2Pair(pool).token1());
        console.log("Reserve0: ", reserve0);
        console.log("Reserve1: ", reserve1);
    }

    // Display information about a Uniswap V3 pool
	function readV3(address pool) public view {
        // (uint160,int24,uint16,uint16,uint16,uint8,bool)
        (uint160 sqrtX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint128 liquidity = IUniswapV3Pool(pool).liquidity();
        int24 tickSpacing = IUniswapV3Pool(pool).tickSpacing();

        console.log("= Uniswap V3 =");
        console.log("Pool: ", pool);
        console.log("Token0: ", IUniswapV3Pool(pool).token0());
        console.log("Token1: ", IUniswapV3Pool(pool).token1());
        console.log("sqrtX96: ", sqrtX96);
        console.log("liquidity: ", liquidity);
        console.log("tickSpacing: ");
        console.logInt(tickSpacing);
	}

    // Compute the exact amount of tokens produced by a given input, using a Uniswap V2 pool. Not needed for Uniswap V3.
    function getExactInput(
        address pool,
        uint amountIn,
        bool zeroForOne
    ) internal view returns (uint amountOut){
        (uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(pool).getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    // Swap tokens through a Uniswap V2 pool
    function swapV2(address pool, address tokenIn, uint amountIn, bool zeroForOne) internal returns (uint){
        // Get the output token
        address tokenOut = zeroForOne ? IUniswapV2Pair(pool).token1() : IUniswapV2Pair(pool).token0();

        // Get the initial balance of the output token
        uint256 initialBalance = IERC20(tokenOut).balanceOf(address(this));

        // Compute the amount of tokens to be received
        uint amountOut = getExactInput(pool, amountIn, zeroForOne);

        console.log("Requesting amountOut: ", amountOut);

        // Swap tokens. Empty data field
        bytes memory data = "";
        if (zeroForOne){
            IUniswapV2Pair(pool).swap(0, amountOut, address(this), data);
        } else {
            IUniswapV2Pair(pool).swap(amountOut, 0, address(this), data);
        }

        // Display current tokenOut balance
        uint delta = IERC20(tokenOut).balanceOf(address(this)) - initialBalance;

        return delta;
    }

    // Swap tokens through a Uniswap V3 pool
    function swapV3(
        address pool,
        bool zeroForOne,
        uint amountIn
    ) internal returns (uint) {

        // Setup the correct sqrtPriceLimit
        uint160 sqrtPriceLimitX96 = 0x110000000;
        uint160 zfo = zeroForOne ? 0 : 1455792646560079078679451688838485039105838153728;
        sqrtPriceLimitX96 += zfo;

        // Find out tokenIn/Out from the zeroForOne boolean
        address tokenIn = zeroForOne ? IUniswapV3Pool(pool).token0() : IUniswapV3Pool(pool).token1();
        address tokenOut = zeroForOne ? IUniswapV3Pool(pool).token1() : IUniswapV3Pool(pool).token0();

        // Read balance before swap
        uint initialBalance = IERC20(tokenOut).balanceOf(address(this));

        // Build the data bytes
        bytes memory data = abi.encode(tokenIn);

        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int(amountIn),
            sqrtPriceLimitX96,
            data
        );

        // Return balance delta
        uint delta = IERC20(tokenOut).balanceOf(address(this)) - initialBalance;
        return delta;
    }

    // Callback function for Uniswap V3 pool
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        // Data contains the tokenIn address and the amountIn
        address tokenIn = abi.decode(data, (address));

        // Repay. the pool wants to be repaid the positive amount.
        if (amount0Delta > 0) {
            IERC20(tokenIn).transfer(msg.sender, uint(amount0Delta));
        } else {
            IERC20(tokenIn).transfer(msg.sender, uint(amount1Delta));
        }
    }

    function run() external {
        // Read data from the pools
        console.log("#### Data read from pools ####");
        address pool1 = 0x45dDa9cb7c25131DF268515131f647d726f50608;
        address pool2 = 0x40A8772A6C917569d28A136A458E3051B96b4AC3;
        address pool3 = 0xbDe5A832760A4C126eEC959ec825D37DC6872064;
        readV3(pool1);
        readV2(pool2);
        readV2(pool3);

        // Pool 1
        console.log("#### Pool 1 ####");
        uint amountIn = 3957993;
        address tokenIn = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
        bool zeroForOne = true;
        // Deal input tokens, send them to the pool
        deal(tokenIn, address(this), amountIn);
        uint tokenBalance = IERC20(tokenIn).balanceOf(address(this));
        console.log("TokenIn balance before swap: ", tokenBalance);
        // IERC20(tokenIn).transfer(pool1, amountIn);
        // uint amountOut = swapV2(pool1, tokenIn, amountIn, zeroForOne);
        uint amountOut = swapV3(pool1, zeroForOne, amountIn);
        console.log("TokenOut received: ", amountOut); // 2446484739300292
        // 2446484739300292 actual
        // 2446484741464768 expected js
        // 2446485355983706 expected py
        // 2446484000000000 clipped js

        // Pool 2
        console.log("#### Pool 2 ####");
        // amountIn = 2446484000000000;
        amountIn = 2446484739300292;
        tokenIn = 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
        zeroForOne = true;
        tokenBalance = IERC20(tokenIn).balanceOf(address(this));
        console.log("TokenIn balance: ", tokenBalance);
        IERC20(tokenIn).transfer(pool2, amountIn);
        uint amountOut2 = swapV2(pool2, tokenIn, amountIn, zeroForOne);
        console.log("TokenOut received: ", amountOut2); // 221736591346427676452
        // 221736591346427676452 actual
        // 260866578054620795825
        // 260866655305567282352 expected js


        // // Pool 3
        // console.log("#### Pool 3 ####");
        // amountIn = 3980637485678051984410;
        // tokenIn = 0x7Ecb5699D8E0a6572E549Dc86dDe5A785B8c29BC;
        // zeroForOne = true;
        // tokenBalance = IERC20(tokenIn).balanceOf(address(this));
        // console.log("TokenIn balance: ", tokenBalance);
        // IERC20(tokenIn).transfer(pool3, amountIn);
        // uint amountOut3 = swapV2(pool3, tokenIn, amountIn, zeroForOne);
        // console.log("TokenOut received: ", amountOut3);

    }
}