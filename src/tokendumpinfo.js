// Description: Dump info from a list of tokens using TokenTools.sol
const { ethers, BigNumber } = require('ethers');

const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    PRIVATE_KEY,
    TRADE_CONTRACT_ABI,
    TOKEN_TOOLS_ABI,
    TRADE_CONTRACT_ADDRESS,
    SAFE_TOKENS,
} = require('./constants');
const { logger, blacklistTokens } = require('./constants');
const { loadAllPoolsFromV2, loadAllPoolsFromV3, keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools, preSelectPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools } = require('./utils');
const { exactTokensOut, computeProfit, optimizeAmountIn } = require('./simulator');
const tokens = require('./tokens');
const fs = require('fs');

// Use in combination with a local forked node synced at the target block:
// anvil --fork-url https://polygon-mainnet.g.alchemy.com/v2/xxx --fork-block-number 47726042

async function dumpTokens() {
    // Send arbitrage transaction
    console.log("Dumping token info...");

    // Use remote RPC node
    const provider = new ethers.providers.JsonRpcProvider(HTTPS_URL);

    // Deployed on mainnet
    const TOKEN_TOOLS_ADDRESS = "0xF06B26C5B5ab7Dae49d0f4dC9aB6E2efC633243F"

    // Create a signer
    const signer = new ethers.Wallet(PRIVATE_KEY);
    const account = signer.connect(provider);
    const tokenTools = new ethers.Contract(TOKEN_TOOLS_ADDRESS, TOKEN_TOOLS_ABI, account);
    const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

    // Read pools from file
    let pools_v2 = JSON.parse(fs.readFileSync('data/v2_pools.json', 'utf8'));
    let pools_v3 = JSON.parse(fs.readFileSync('data/v3_pools.json', 'utf8'));
    console.log(`Initial V2 pool count: ${Object.keys(pools_v2).length}`);
    console.log(`Initial V3 pool count: ${Object.keys(pools_v3).length}`);
    let pools = Object.values(pools_v2).concat(Object.values(pools_v3));
    const tokens = {}; // Set of tokens
    // Build a list of all the tokens found.
    for (const pool of pools) {
        tokens[pool.token0] = true;
        tokens[pool.token1] = true;
    }

    // Try to read dump_failed_chunks.json. If it exists and is not empty, use it to retry failed chunks. Otherwise, start from scratch.
    let tokensToProcess = Object.keys(tokens);
    
    // NOTE: Comment this out to always start from scratch. Otherwise, re-start from failed chunks.
    try {
        let failedChunks = JSON.parse(fs.readFileSync('data/dump_failed_chunks.json', 'utf8'));
        if (failedChunks.length > 0) {
            console.log("Found failed", failedChunks.length, "chunks. Overriding the list with the failed chunks.");
            // Flatten the failed chunks. Override the list
            tokensToProcess = failedChunks.flat();
        } else {
            console.log("Failed chunks file empty.");
        }
    }catch (err) {
        console.log("No failed chunks file found.");
    }

    // Split the tokens into chunks
    const CHUNK_SIZE = 100;
    console.log("Using chunk size: ", CHUNK_SIZE);
    let tokenChunks = tokensToProcess.reduce((resultArray, item, index) => {
        const chunkIndex = Math.floor(index / CHUNK_SIZE)
        if (!resultArray[chunkIndex]) {
            resultArray[chunkIndex] = [] // start a new chunk
        }
        resultArray[chunkIndex].push(item)
        return resultArray
    }, []);
    console.log("Token chunk count: ", tokenChunks.length);

    // For each chunk, get the token info
    let tokenInfo = {};
    try {
        let readTokenInfo = JSON.parse(fs.readFileSync('data/dump_token_info.json', 'utf8'));
        tokenInfo = readTokenInfo;
        console.log("Read token info count: ", Object.keys(tokenInfo).length);
    } catch (err) {
        console.log("No token info file found.");
    }
    const failedChunks = []; // There are some chunks that fail. Save for later processing.
    let i = 0;
    for (const tokenChunk of tokenChunks) {
        // Make an eth_call to the tokenTools contract to get the token info
        let tokenChunkInfoArray;
        try {
            tokenChunkInfoArray = await tokenTools.getTokenInfo(tokenChunk);
            // console.log("Current token chunk info: ", tokenChunkInfoArray);

            // For each token in the chunk, update the token info
            tokenChunk.forEach((token, index) => {
                let tokenObj = {
                    name: tokenChunkInfoArray[index].name,
                    symbol: tokenChunkInfoArray[index].symbol,
                    decimals: tokenChunkInfoArray[index].decimals,
                };
                tokenInfo[token] = tokenObj;
            });
            console.log("Processed token chunk: ", i);
        } catch (err) {
            console.log("Error getting token info. Index: ", i, " Error: ", err);
            failedChunks.push(tokenChunk);
        }
        i++;
    }
    // Save the failed chunks to a file
    console.log("Failed token count: ", failedChunks.length * CHUNK_SIZE);
    fs.writeFileSync('data/dump_failed_chunks.json', JSON.stringify(failedChunks), 'utf8');
    console.log("Failed chunks saved to file. They will be retried on the next run.");

    // Filter out tokens with no info: either name/symbol/decimals is empty
    const filteredTokenInfo = {};
    let badTokens = {};
    // Read badTokens from file if it exists
    try {
        badTokens = JSON.parse(fs.readFileSync('data/dump_bad_token_info.json', 'utf8'));
        console.log("Found bad tokens file. Read ", Object.keys(badTokens).length, " bad tokens.");
    } catch (err) {
        console.log("No bad tokens file found.");
    }
    for (const [token, info] of Object.entries(tokenInfo)) {
        if (info.name && info.symbol && info.decimals > 0) {
            // Good token (at least has name, symbol, decimals)
            filteredTokenInfo[token] = info;
        } else {
            // Bad token
            badTokens[token] = info;
        }
    }
    // Save bad tokens to a file
    console.log("Total tokens with bad info: ", Object.keys(badTokens).length);
    fs.writeFileSync('data/dump_bad_token_info.json', JSON.stringify(badTokens), 'utf8');
    // Save filtered token info to a file
    console.log("Filtered token info count: ", Object.keys(filteredTokenInfo).length);
    fs.writeFileSync('data/dump_token_info.json', JSON.stringify(filteredTokenInfo), 'utf8');
}

dumpTokens();