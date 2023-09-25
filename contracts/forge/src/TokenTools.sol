// This smart contract is used to gather info about a list of tokens.
// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8;

interface IERC20{
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool); 
}

struct TokenInfo{
    string name;
    string symbol;
    uint8 decimals;
}

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

interface IUniswapV2Callee {
	function uniswapV2Call(
		address sender,
		uint amount0,
		uint amount1,
		bytes calldata data
	) external;
}

contract TokenTools is IUniswapV2Callee{

    // Tries to fetch the token info for a list of tokens. Returns empty values for broken tokens.
    function getTokenInfo(IERC20[] calldata _tokens) external view returns(TokenInfo[] memory){
        TokenInfo[] memory result = new TokenInfo[](_tokens.length);
        for(uint i = 0; i < _tokens.length; i++){
            // If the call reverts, then the token does not implement the ERC20 interface. We fill empty values.

            // Use low level call
            // Name
            (bool success, bytes memory data) = address(_tokens[i]).staticcall(abi.encodeWithSignature("name()"));
            if (success && data.length > 0) {
                result[i].name = abi.decode(data, (string));
            } else {
                result[i].name = "";
            }

            // Symbol
            (success, data) = address(_tokens[i]).staticcall(abi.encodeWithSignature("symbol()"));
            if (success && data.length > 0) {
                result[i].symbol = abi.decode(data, (string));
            } else {
                result[i].symbol = "";
            }

            // Decimals
            (success, data) = address(_tokens[i]).staticcall(abi.encodeWithSignature("decimals()"));
            if (success && data.length > 0) {
                result[i].decimals = abi.decode(data, (uint8));
            } else {
                result[i].decimals = 0;
            }
        }
        return result;
    }

    // This function will try to perform a swap and a transfer of the tokens.
    function trySwapTransfer(
        address[] memory _tokens,
        address[] memory _pools,
        uint256[] memory _amountsOut,
        bool[] memory _zeroForOne, // If true, then token0 is the input token and token1 is the output token.
        address target
    ) external returns(bool[] memory){
        require(_tokens.length == _pools.length && _pools.length == _amountsOut.length, "Input arrays lengths mismatch");

        bool[] memory swapResults = new bool[](_tokens.length);

        for(uint256 i = 0; i < _tokens.length; i++){
            bytes memory data = abi.encode(_tokens[i], target);

            IUniswapV2Pair pool = IUniswapV2Pair(_pools[i]);
            
            // Try to swap the tokens.
            (bool success, bytes memory result) = address(pool).call(abi.encodeWithSignature(
                "swap(uint256,uint256,address,bytes)",
                _zeroForOne[i] ? 0 : _amountsOut[i],
                _zeroForOne[i] ? _amountsOut[i] : 0,
                address(this),
                data
            ));
            
            if (!success) {
                // Check if the call failed with 'ok' revert message
                if (result.length > 0) {
                    string memory reason;
                    // The call failed, extract the correct error message
                    assembly {
                        // At the location of the message string.
                        reason := add(result, 0x44)
                    }

                    // Compare the reason string to the "ok" string.
                    swapResults[i] = keccak256(abi.encodePacked(reason)) == keccak256(abi.encodePacked("ok"));
                    
                } else {
                    // The call failed, but we don't know why.
                    swapResults[i] = false;
                }
            } else {
                // This should never happen.
                swapResults[i] = false;
            }
        }

        return swapResults;
    }

    // Callback where we try to send the tokens to the target.
    function uniswapV2Call(
        address sender,
        uint amount0,
        uint amount1,
        bytes calldata data
    ) external override{
        // Decode the data
        (address tokenAddress, address target) = abi.decode(data, (address, address));

        // Check the balance beforehand and transfer the tokens.
        uint256 initialBalance = IERC20(tokenAddress).balanceOf(target);
        
        // Try to transfer the tokens.
        IERC20(tokenAddress).transfer(target, amount0 > 0 ? amount0 : amount1);

        // Check if the balance was updated correctly.
        require(
            IERC20(tokenAddress).balanceOf(target) == initialBalance + (amount0 > 0 ? amount0 : amount1),
            "Funds not received"
        );

        // Everything went fine, revert to signal success.
        // require(false, "ok");
        revert("ok");
    }
}
