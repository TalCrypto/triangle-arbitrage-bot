//SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8;


interface IUniswapV3Pool{
	function liquidity() external view returns (uint128);
	function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    // function slot0() external view returns (Slot0 memory);
	// function ticks(int24 tickIndex) external view returns(Info memory);
    // function tickSpacing() external view returns (int24);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

// In order to quickly load up data from Uniswap-like market, this contract allows easy iteration with a single eth_call
contract FlashQuery{

	// Uniswap V3: fetch only current liquidity, ignore the neighbhouring ticks
	function getLiquidityV3(IUniswapV3Pool[] calldata _pools) external view returns(uint160[] memory, int128[] memory, uint256[] memory, uint256[] memory) {
        uint160[] memory sqrtResult = new uint160[](_pools.length);
		int128[] memory liqResult = new int128[](_pools.length);
        uint256[] memory amounts0 = new uint256[](_pools.length);
        uint256[] memory amounts1 = new uint256[](_pools.length);
        for(uint i = 0; i < _pools.length; i++){
            // (uint160,int24,uint16,uint16,uint16,uint8,bool)
            (uint160 sqrtX96,,,,,,) = _pools[i].slot0();
            sqrtResult[i] = sqrtX96;
			liqResult[i] = int128(_pools[i].liquidity());
            amounts0[i] = IERC20(_pools[i].token0()).balanceOf(address(_pools[i]));
            amounts1[i] = IERC20(_pools[i].token1()).balanceOf(address(_pools[i]));
        }
        return (sqrtResult, liqResult, amounts0, amounts1);
	}
}

// Deployed on Polygon at 0xa5aeC6cF29e66fD47F6a05dcc0c8aCD308d80B4E

// Note: Spacing vs Fee (in % of bip = 1/1 000 000) in V3
// 1 = 100 (0.01%)
// 10 = 500 (0.05%)
// 60 = 3000 (0.3%)
// 200 = 10000 (1%)