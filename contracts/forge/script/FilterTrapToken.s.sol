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
        uint256 amount = 1e6;
        uint256 poolBalance = IERC20(tokenAddress).balanceOf(poolAddress);
        if (poolBalance < amount) {
            amount = poolBalance / 2;
        }
        if(amount == 0) {
            return true;
        }

        address target = address(1);
        changePrank(poolAddress);
        // deal(tokenAddress, address(this), amount);

        uint256 balanceBefore = IERC20(tokenAddress).balanceOf(target);
        (bool success, bytes memory data) = tokenAddress.call(abi.encodeWithSelector(0xa9059cbb, target, amount));
        if(success && (data.length == 0 || abi.decode(data, (bool)))) {
            // IERC20(tokenAddress).transfer(target, amount);
            uint256 balanceAfter = IERC20(tokenAddress).balanceOf(target);
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
