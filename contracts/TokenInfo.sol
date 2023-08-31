// This smart contract is used to gather info about a list of tokens.
// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8;

interface IERC20{
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);   
}

struct TokenInfo{
    string name;
    string symbol;
    uint8 decimals;
}

contract TokenDecimals{
    function getTokenInfo(IERC20[] calldata _tokens) external view returns(TokenInfo[] memory){
        TokenInfo[] memory result = new TokenInfo[](_tokens.length);
        for(uint i = 0; i < _tokens.length; i++){
            // If revert, then the token does not implement the interface, return empty values.
            try _tokens[i].name() returns (string memory name){
                result[i].name = name;
            } catch {
                result[i].name = "";
            }
            try _tokens[i].symbol() returns (string memory symbol){
                result[i].symbol = symbol;
            } catch {
                result[i].symbol = "";
            }
            try _tokens[i].decimals() returns (uint8 decimals){
                result[i].decimals = decimals;
            } catch {
                result[i].decimals = 0;
            }
        }
        return result;
    }
}