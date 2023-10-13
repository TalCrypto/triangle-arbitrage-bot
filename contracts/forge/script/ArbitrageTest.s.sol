// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "../src/TradeContract.sol";
import "forge-std/Script.sol";
import "forge-std/console.sol";
import "forge-std/StdCheats.sol";
import "../lib/openzeppelin-contracts/contracts/utils/Strings.sol";

contract Arbitrage is Script, StdCheats {
    TradeContract public tradeContract = TradeContract(payable(0x999e3cdd9E1c80dF0D6A8A7a5Dc6A3A77F1Dfd24));
    address constant owner = 0x14e27d280553673CB82be1B6F60eB4D25122aeA9;

    // Pool Addresses
    address constant pool0 = 0x1A6F6af2864b1f059A2E070140e373D6e3AAA2A1;
    address constant pool1 = 0x6CE2400ABd570b38eE2937D44521ee77773eA7e4;
    address constant pool2 = 0x4152ea409F10F7d6efDCa92149fDE430A8712b02;

    // constant zeroForOne parameter, for each pool
    bool constant zfo0 = false;
    bool constant zfo1 = true;
    bool constant zfo2 = true;

    // constant Token Addresses
    address constant token0 = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address constant token1 = 0x204820B6e6FEae805e376D2C6837446186e57981;
    address constant token2 = 0x7Ecb5699D8E0a6572E549Dc86dDe5A785B8c29BC;

    // constant Token amounts involved
    uint constant amount0 = 21586;
    uint constant amount1 = 12723444981068115933;
    uint constant amount2 = 3980637485678051984410;
    uint constant amount3 = 22230;

    function run() external {
        // Set up the callback data for each step of the arbitrage path. Start from the last step.
        // No inner action to start in the callback. Pool2 must repay amount2 to its calling pool.

        bytes memory data3 = abi.encode(CallBackData(0, ""),
            address(token2), amount2); // Repay pool2
        console.log("data3: ", vm.toString(data3));

        bytes memory data2 = abi.encode(CallBackData(2,
            abi.encode(address(pool2), amount3, address(tradeContract), zfo2, data3)), // Call pool2
            address(token1), amount1); // Repay pool1
        console.log("data2: ", vm.toString(data2));

        // In the callback of pool0, call pool1 and repay amount0 to pool0
        bytes memory data1 = abi.encode(CallBackData(2,
            abi.encode(address(pool1), amount2, address(tradeContract), zfo1, data2)), // Call pool1
            address(token0), amount0); // Repay pool0
        console.log("data1: ", vm.toString(data1));

        // Action that triggers the chain. Starts with a call to pool0.
        CallBackData memory intialAction = CallBackData(2,
            abi.encode(address(pool0), amount1, address(tradeContract), zfo0, data1)); // Call pool0
        console.log("intialAction raw data: ", vm.toString(intialAction.rawData));

        // Execute arbitrage
        // Register tx.origin as this address (to circumvent the security check in the contract)
        vm.prank(owner, owner);
        tradeContract.execute(intialAction);

        // Check if the final balance of the contract in token0 has increased.
        // token0.balanceOf(address(tradeContract)
        console.log("Final balance: ", IERC20(token0).balanceOf(address(tradeContract)));
    }
}