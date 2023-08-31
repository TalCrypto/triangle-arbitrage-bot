// This module handles the logic for fetching info regarding tokens.
// - Token Basic Info: Name, Symbol, Decimals
// - Token Full Info (Coinmarketcap): Price, Market Cap, Volume, etc.
// - Safe Tokens: Tokens that are listed on Coinmarketcap and have a market cap > 1M

const axios = require('axios');
const { ethers } = require('ethers');
const { logger } = require('./constants');
const constants = require('./constants');

const coinmarketcapUrl = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest';
const safeTokenMinMarketCap = 10000000;
const coinmarketcapHeaders = {
    'Accept': 'application/json',
    'X-CMC_PRO_API_KEY': constants.COINMARKETCAP_API_KEY,
};


async function getBasicInfo(tokenAddresses){
    //TODO: Implement
}

async function getFullInfo(tokenAddresses){
    //TODO: Implement
}

async function getSafeTokens(){
    try {
        const coinmarketcapParams = {
            'start': '1',
            'limit': 5000, // Max. number of items to fetch per query
            'sort': 'market_cap',
            'volume_24h_min': safeTokenMinMarketCap, // Min. $usd volume to filter out low volume tokens
            'sort_dir': 'desc',
            'convert': 'USD',
        };

        let safeTokens = {};

        // If we receive less than 'total_count' tokens, we increment 'start' by 'limit' and fetch again.
        // We keep doing this until we receive all tokens.

        let start = 1;
        let limit = 5000;
        let total_count = 0;
        let received_count = 0;

        do {
            coinmarketcapParams.start = start;
            let response = await axios.get(coinmarketcapUrl, {
                params: coinmarketcapParams,
                headers: coinmarketcapHeaders,
            });
            total_count = response.data.status.total_count;
            received_count += response.data.data.length;
            start += limit;

            for (let token of response.data.data) {
                // We want tokens with platform = "polygon"
                safeTokens[token.symbol] = token;
            }
        } while (received_count < total_count);

        return safeTokens;
    } catch (err) {
        logger.error("Failed to fetch safe tokens from Coinmarketcap. Returning default tokens");
        console.log(err);
        return constants.SAFE_TOKENS;
    }
        
}


function exctractTokens(pools) {// {pool1, pool2, pool3, ...}
    let tokens = {};

    for (let pool of Object.values(pools)) {
        tokens[pool.token0] = true;
        tokens[pool.token1] = true;
    }
    return Object.keys(tokens);
}

module.exports = {
    getSafeTokens,
    exctractTokens,
};