// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../src/TradeContract.sol";
import "../lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract mockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        _mint(msg.sender, 1000 ether);
    }
}

contract mockPool {
    address public token0;
    address public token1;

    uint private reserve0;
    uint private reserve1;

    // Set the pool tokens
    constructor(address _token0, address _token1){
        if (_token0 < _token1) {
            token0 = _token0;
            token1 = _token1;
        } else {
            token0 = _token1;
            token1 = _token0;
        }
    }

    // Init the reserveN variables with the amount of tokens in the pool
    function init() external {
        reserve0 = ERC20(token0).balanceOf(address(this));
        reserve1 = ERC20(token1).balanceOf(address(this));
    }

    // Swap function, with non-essential parts removed
    function swap(
        uint amount0Out,
        uint amount1Out,
        address to,
        bytes calldata data
    ) external {
        require(
            amount0Out > 0 || amount1Out > 0,
            "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT"
        );
        (uint _reserve0, uint _reserve1) = (reserve0, reserve1); // gas savings
        require(
            amount0Out < _reserve0 && amount1Out < _reserve1,
            "UniswapV2: INSUFFICIENT_LIQUIDITY"
        );

        uint balance0;
        uint balance1;
        {
            // scope for _token{0,1}, avoids stack too deep errors
            address _token0 = token0;
            address _token1 = token1;
            require(to != _token0 && to != _token1, "UniswapV2: INVALID_TO");

            // Transfer tokens to the recipient
            if (amount0Out > 0) IERC20(_token0).transfer(to, amount0Out); // optimistically transfer tokens
            if (amount1Out > 0) IERC20(_token1).transfer(to, amount1Out); // optimistically transfer tokens

            if (data.length > 0)
                // Calling the callback function
                IUniswapV2Callee(to).uniswapV2Call(
                    msg.sender,
                    amount0Out,
                    amount1Out,
                    data
                );
            balance0 = IERC20(_token0).balanceOf(address(this));
            balance1 = IERC20(_token1).balanceOf(address(this));
        }
        uint amount0In = balance0 > _reserve0 - amount0Out
            ? balance0 - (_reserve0 - amount0Out)
            : 0;
        uint amount1In = balance1 > _reserve1 - amount1Out
            ? balance1 - (_reserve1 - amount1Out)
            : 0;
        require(
            amount0In > 0 || amount1In > 0,
            "UniswapV2: INSUFFICIENT_INPUT_AMOUNT"
        );
        {
            // scope for reserve{0,1}Adjusted, avoids stack too deep errors
            uint balance0Adjusted = (balance0 * 1000) - (amount0In * 3);
            uint balance1Adjusted = (balance1 * 1000) - (amount1In * 3);
            require(
                balance0Adjusted * balance1Adjusted >=
                    _reserve0 * _reserve1 * 1000 ** 2,
                "UniswapV2: K"
            );
        }

        // _update(balance0, balance1, _reserve0, _reserve1);
        reserve0 = uint(balance0);
        reserve1 = uint(balance1);
    }

    // Helper function to calculate the amount of tokens to swap to get an exact amount of tokens
    function getExactInput(
        uint amountOut,
        bool zeroForOne
    ) external view returns (uint amountIn) {
        (uint _reserve0, uint _reserve1) = (reserve0, reserve1);
        require(amountOut > 0, "UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT");
        require(
            _reserve0 > 0 && _reserve1 > 0,
            "UniswapV2Library: INSUFFICIENT_LIQUIDITY"
        );

        if (zeroForOne) {
            amountIn = 1 + (_reserve0*amountOut*1000)/((_reserve1 - amountOut) * 997);
        } else {
            amountIn = 1 + (_reserve1*amountOut*1000)/((_reserve0 - amountOut) * 997);
        }
    }

    // Calculate the output from a given input of tokens
    function getExactOutput(
        uint amountIn,
        bool zeroForOne
    ) external view returns (uint amountOut) {
        (uint _reserve0, uint _reserve1) = (reserve0, reserve1);
        require(amountIn > 0, "UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT");
        require(
            _reserve0 > 0 && _reserve1 > 0,
            "UniswapV2Library: INSUFFICIENT_LIQUIDITY"
        );

        if (zeroForOne) {
            uint dx = amountIn * 997;
            amountOut = (dx * _reserve1) / (_reserve0 * 1000 + dx);
        } else {
            uint dy = amountIn * 997;
            amountOut = (dy * _reserve0) / (_reserve1 * 1000 + dy);
        }
    }
}

contract TradeContractTest is Test {
    TradeContract public tradeContract;
    mockToken public token0;
    mockToken public token1;
    mockToken public token2;
    mockPool public pool0;
    mockPool public pool1;
    mockPool public pool2;

    function setUp() public {
        tradeContract = new TradeContract();
        token0 = new mockToken("Token0", "T0");
        token1 = new mockToken("Token1", "T1");
        token2 = new mockToken("Token2", "T2");
        pool0 = new mockPool(address(token0), address(token1));
        pool1 = new mockPool(address(token1), address(token2));
        pool2 = new mockPool(address(token2), address(token0));

        // Set up initial balances
        token0.transfer(address(pool0), 10 ether);
        token1.transfer(address(pool0), 20 ether);
        pool0.init();

        token1.transfer(address(pool1), 10 ether);
        token2.transfer(address(pool1), 10 ether);
        pool1.init();

        token2.transfer(address(pool2), 10 ether);
        token0.transfer(address(pool2), 10 ether);
        pool2.init();
    }

    // Test execute function with 3 hops, only V2 pools
    function testExecute_swaps() public {
        // Arbitrage path is schematically: tradeContract -(token0)-> pool0 -(token1)-> pool1 -(token2)-> pool2 -(token0)-> tradeContract
        // We use flash swaps to perform the trade since the tradeContract is not supposed to have any funds.
        // Each swap is a flash swap for simplicity. The funds are sent to the calling pool inside of the callback.
        // To build this chain of flash swaps, we start by the innermost swap, which is the last one to be executed in the transaction.

        // Read the initial balance of the contract in token0, to check if it has increased after the trade.
        uint256 initialBalance = token0.balanceOf(address(tradeContract));

        // Token amounts involved
        uint amount0 = 1 ether; // Intial input amount in the trade path
        uint amount1 = 1813000000000000000; // 1813221787760297984
        uint amount2 = 1530000000000000000; // 1530850444050214912
        uint amount3 = 1323000000000000000; // 1323519076544782336

        // zeroForOne parameter, for each pool
        bool zfo0 = address(token0) < address(token1);
        bool zfo1 = address(token1) < address(token2);
        bool zfo2 = address(token2) < address(token0);


        // Set up the callback data for each step of the arbitrage path. Start from the last step.
        // No inner action to start in the callback. Pool2 must repay amount2 to its calling pool.
        bytes memory data3 = abi.encode(CallBackData(0, ""),
            address(token2), amount2); // Repay pool2

        bytes memory data2 = abi.encode(CallBackData(2,
            abi.encode(address(pool2), amount3, address(tradeContract), zfo2, data3)), // Call pool2
            address(token1), amount1); // Repay pool1

        // In the callback of pool0, call pool1 and repay amount0 to pool0
        bytes memory data1 = abi.encode(CallBackData(2,
            abi.encode(address(pool1), amount2, address(tradeContract), zfo1, data2)), // Call pool1
            address(token0), amount0); // Repay pool0

        // Action that triggers the chain. Starts with a call to pool0.
        CallBackData memory intialAction = CallBackData(2,
            abi.encode(address(pool0), amount1, address(tradeContract), zfo0, data1)); // Call pool0


        // Execute arbitrage
        // Register tx.origin as this address (to circumvent the security check in the contract)
        vm.prank(address(this), address(this));
        tradeContract.execute(intialAction);

        // Check if the final balance of the contract in token0 has increased.
        assertEq(token0.balanceOf(address(tradeContract)), initialBalance + amount3 - amount0);
    }
}