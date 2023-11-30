// This script filters trap tokens.
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import 'forge-std/Script.sol';
import 'forge-std/StdCheats.sol';
import 'forge-std/console.sol';

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address recipient, uint256 amount) external;
}

contract FilterTrapToken is Script, StdCheats {
    using stdJson for string;

    function isTrapToken(
        address poolAddress,
        address tokenAddress
    ) internal returns (bool) {
        // assume the token balance of pool is bigger than 10_000, else not enough liquidity as we consider down to 3 decimals
        uint256 amount = 1e4;
        address target = address(1);
        changePrank(poolAddress);
        // deal(tokenAddress, address(this), amount);

        // get balance, it sometimes fails in toxic tokens
        (bool success, bytes memory data) = tokenAddress.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, target));
        if(!success) {
            return true;
        }
        uint256 balanceBefore = abi.decode(data, (uint256));

        // token transfer
        (success, data) = tokenAddress.call(abi.encodeWithSelector(IERC20.transfer.selector, target, amount));
        if(success && (data.length == 0 || abi.decode(data, (bool)))) {
            (success, data) = tokenAddress.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, target));
            if(!success) {
                return true;
            }
            uint256 balanceAfter = abi.decode(data, (uint256));
            if (balanceAfter - balanceBefore == amount) {
                return false;
            } else {
                return true;
            }
        } else {
            return true;
        }      
    }

    function run() external {
        string memory root = vm.projectRoot();
        string memory poolPath = string.concat(root, '/external/pools.json');
        string memory tokenPath = string.concat(root, '/external/tokens.json');
        string memory poolJson = vm.readFile(poolPath);
        string memory tokenJson = vm.readFile(tokenPath);
        address[] memory pools = poolJson.readAddressArray('');
        address[] memory tokens = tokenJson.readAddressArray('');
        address[] memory validTokenAddresses = new address[](pools.length);
        address[] memory invalidTokenAddresses = new address[](pools.length);
        // bool result = isFork();
        for (uint256 i = 0; i < pools.length; i++) {
            bool result = isTrapToken(pools[i], tokens[i]);
            if (result) {
                invalidTokenAddresses[i] = tokens[i];
            } else {
                validTokenAddresses[i] = tokens[i];
            }
        }
        vm.writeJson(vm.serializeAddress("", "valid", validTokenAddresses), string.concat(root, '/external/validTokens.json'));
        vm.writeJson(vm.serializeAddress("", "invalid", invalidTokenAddresses), string.concat(root, '/external/invalidTokens.json'));
    }
}
