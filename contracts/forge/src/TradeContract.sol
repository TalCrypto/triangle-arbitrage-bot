//SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8;

// import "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

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
	function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external;
}

interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
}

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint) external;
}

interface IUniswapV2Callee {
	function uniswapV2Call(
		address sender,
		uint amount0,
		uint amount1,
		bytes calldata data
	) external;
}

interface IUniswapV3SwapCallback {
    /// @notice Called to `msg.sender` after executing a swap via IUniswapV3Pool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be checked to be a UniswapV3Pool deployed by the canonical UniswapV3Factory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IUniswapV3PoolActions#swap call
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}

// Contains data for the callback function
struct CallBackData {
    uint256 actionType; // 0 for do nothing, 1 for transfer, 2 for uniswap v2 swap, 3 for uniswap v3 swap
    bytes rawData; // Data to be decoded. Contains parameters for the current callback. (transfer parameters/swap parameters)
    // For transfer: (token, to, amount)
    // For swap: (pool, amountOut, to, zeroForOne, data)
}

contract TradeContract is IUniswapV2Callee,IUniswapV3SwapCallback {
    address immutable owner;

    // Function to decode the callback data of a transfer
    function cbd_transfer(bytes memory callbackdata_transfer) internal {
        (address token, address to, uint256 amount) = abi.decode(callbackdata_transfer, (address, address, uint256));
        IERC20(token).transfer(to, amount);
    }

    // Function to decode the callback data of a uniswap v2 swap
    function cbd_swapV2(bytes memory callbackdata_swapV2) internal {
        (address pool, uint256 amountOut, address to, bool zeroForOne, bytes memory data) = abi.decode(callbackdata_swapV2, (address, uint256, address, bool, bytes));
        IUniswapV2Pair(pool).swap(zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0, to, data);
    }

    // Function to decode the callback data of a uniswap v3 swap
    function cbd_swapV3(bytes memory callbackdata_swapV3) internal {
        (address pool, uint256 amountOut, address to, bool zeroForOne, bytes memory data) = abi.decode(callbackdata_swapV3, (address, uint256, address, bool, bytes));
        uint160 sqrtPriceLimitX96 = 0x110000000;

        // Set the correct sqrtPriceLimitX96
        // uint256 zfo = zeroForOne ?  0 : 0xfefffffffffffffffffffffffffffffef0000000;
        uint160 zfo = zeroForOne ? 0 : 1455792646560079078679451688838485039105838153728;
        sqrtPriceLimitX96 += zfo;

        // Set the swap as exactOutput (amountSpecified < 0)
        IUniswapV3Pool(pool).swap(to, zeroForOne, -int256(amountOut), sqrtPriceLimitX96, data);
    }

    
    constructor() {
        owner = msg.sender;
    }

    // Not flexible for now.
    function execute(CallBackData memory cbd) public {
        // Security check
        require(tx.origin == owner, "NO");

        // Execute the callback
        if(cbd.actionType == 0){
            // Do nothing
        }else if(cbd.actionType == 1){
            cbd_transfer(cbd.rawData);
        }else if(cbd.actionType == 2){
            cbd_swapV2(cbd.rawData);
        }else if(cbd.actionType == 3){
            cbd_swapV3(cbd.rawData);
        }
    }

    receive() external payable{
    }

	function uniswapV2Call(address _sender, uint _amount0, uint _amount1, bytes calldata _data) external override {
        // Decode the callback data. Conains info about the next action to carry out, and how to repay the calling pool.
        (CallBackData memory cbd, address repayToken, uint repayAmount) = abi.decode(_data, (CallBackData, address, uint));
        
        // Execute the callback
        execute(cbd);

        // Repay the calling pool
        IERC20(repayToken).transfer(msg.sender, repayAmount);
  	}
    
	function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata _data) external override{
        // Decode the callback data. Conains info about the next action to carry out, and how to repay the calling pool.
        (CallBackData memory cbd, address repayToken, uint repayAmount) = abi.decode(_data, (CallBackData, address, uint));
        
        // Execute the callback
        execute(cbd);

        // Repay the calling pool
        IERC20(repayToken).transfer(msg.sender, repayAmount);
	}
}