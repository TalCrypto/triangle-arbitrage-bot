// Description: Try to perform a token transfer using 
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

    // Read V2 pools from file
    let pools_v2 = JSON.parse(fs.readFileSync('data/v2_pools.json', 'utf8'));
    console.log(`Initial V2 pool count: ${Object.keys(pools_v2).length}`);
    const tokenPools = {}; // Finds at least one pool for each token
    // Build a list of all the tokens found. For each token, store one pool object.
    for (const pool of Object.values(pools_v2)) {
        // Only add the pool if it involves wmatic. Store the corresponding token.
        if (pool.token0 == WMATIC) {
            tokenPools[pool.token1] = pool;
        } else if (pool.token1 == WMATIC) {
            tokenPools[pool.token0] = pool;
        }
    }

    // Read list of valid tokens from file
    console.log("Reading valid tokens from file...");
    let filteredTokenInfo = JSON.parse(fs.readFileSync('data/dump_token_info.json', 'utf8'));
    console.log("Valid token count: ", Object.keys(filteredTokenInfo).length);
    // Warning: this contains the full list of tokens (v2 and v3). We might need to ignore some.
    // DEBUG: Uncomment to retry only tokens that failed
    try {
        console.log("DEBUG: Restricting to tokens that need retrying... Overriding valid tokens.");
        filteredTokenInfo = JSON.parse(fs.readFileSync('data/dump_retry_tokens.json', 'utf8'));
        console.log("DEBUG: Retry token count: ", Object.keys(filteredTokenInfo).length);
    }catch (err) {
        console.log("DEBUG: No retry tokens found.");
    }

    // Make an eth_call to the tokenTools contract to get the pool info
    const tokenListFull = [];
    // Only store tokens that are both in tokenPools and filteredTokenInfo (intersection of the two sets)
    for (const token of Object.keys(filteredTokenInfo)) {
        if (tokenPools[token]) {
            tokenListFull.push(token);
        }
    }
    // Split the tokens into chunks
    const chunkSizeSwapTest = 1;
    const tokenChunksSwapTest = tokenListFull.reduce((resultArray, item, index) => {
        const chunkIndex = Math.floor(index / chunkSizeSwapTest)
        if (!resultArray[chunkIndex]) {
            resultArray[chunkIndex] = [] // start a new chunk
        }
        resultArray[chunkIndex].push(item)
        return resultArray
    }, []);
    console.log("Token test swap chunk count: ", tokenChunksSwapTest.length);

    // For each chunk, get the token info
    let validTokens = {};
    try {
        // Read validTokens from file if it exists
        const readValid = JSON.parse(fs.readFileSync('data/dump_valid_tokens.json', 'utf8'));
        console.log("Found valid token file. Read ", Object.keys(readValid).length, " valid tokens.");
        validTokens = readValid;
    } catch (err) {
        console.log("No valid token file found.");
    }
    let invalidTokens = {};
    try {
        // Read invalidTokens from file if it exists
        const readInvalid = JSON.parse(fs.readFileSync('data/dump_invalid_tokens.json', 'utf8'));
        console.log("Found invalid tokens file. Read ", Object.keys(readInvalid).length, " invalid tokens.");
        invalidTokens = readInvalid;
    } catch (err) {
        console.log("No invalid token file found.");
    }
    let retryTokens = {};
    let chunkCount = 0;
    for (const tokenChunk of tokenChunksSwapTest) {
        const poolList = tokenChunk.map(token => tokenPools[token]);
        const poolAddresses = poolList.map(pool => pool.address);
        const amountList = tokenChunk.map(token => {
            return 100; // 100 unit of the token. Should not be a problem.
        });
        const zeroForOneList = poolList.map(pool => pool.token0 == WMATIC); // swap target token for WMATIC
        
        console.log("Trying chunk: ", chunkCount, "Length: ", tokenChunk.length);
        try {
            const swapResults = await tokenTools.trySwapTransfer(
                tokenChunk,
                poolAddresses,
                amountList,
                zeroForOneList,
                "0x14e27d280553673CB82be1B6F60eB4D25122aeA9" // target recipient
            )

            // If the result is true, add the token to the list
            swapResults.forEach((result, index) => {
                let token = tokenChunk[index];
                if (result) {
                    validTokens[token] = filteredTokenInfo[token];
                } else {
                    invalidTokens[token] = filteredTokenInfo[token];
                }
            });
        } catch (err) {
            console.log("Error getting token info. Error: ", err);
            tokenChunk.forEach(token => {
                retryTokens[token] = filteredTokenInfo[token];
            });
        }
        chunkCount++;
    }
    // Save to a file
    // Valid tokens
    console.log("Valid tokens: ", Object.keys(validTokens).length);
    fs.writeFileSync('data/dump_valid_tokens.json', JSON.stringify(validTokens), 'utf8');
    console.log("Token data valid saved to file.");
    // Retry tokens
    console.log("Retry tokens: ", Object.keys(retryTokens).length);
    fs.writeFileSync('data/dump_retry_tokens.json', JSON.stringify(retryTokens), 'utf8');
    console.log("Token data 'retry' saved to file. Warning: need to retry manually.");
    // Invalid tokens
    if (chunkSizeSwapTest == 1) {
        // If we are at the finest granularity, save invalid tokens to file
        console.log("Finest granularity reached (CHUNK_SIZE == 1). Retry tokens are conbsidered invalid.");
        Object.assign(invalidTokens, retryTokens);
        console.log("The 'retry' tokens fail in a way not handled by the TokenTools contract.");
    }
    console.log("Failed tokens: ", Object.keys(invalidTokens).length);
    fs.writeFileSync('data/dump_invalid_tokens.json', JSON.stringify(invalidTokens), 'utf8');
    console.log("Token data invalid saved to file.");
}

dumpTokens();