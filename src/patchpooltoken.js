// Description: Try to perform a token transfer using
const fs = require('fs');

// Use in combination with a local forked node synced at the target block:
// anvil --fork-url https://polygon-mainnet.g.alchemy.com/v2/xxx --fork-block-number 47726042

async function dumpTokens() {
    // Send arbitrage transaction
    console.log('Patching pool and token list...');

    const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

    // Read V2 pools from file
    let pools_v2 = JSON.parse(fs.readFileSync('data/v2_pools.json', 'utf8'));
    let pools_v3 = JSON.parse(fs.readFileSync('data/v3_pools.json', 'utf8'));
    console.log(`Initial V2 pool count: ${Object.keys(pools_v2).length}`);
    console.log(`Initial V3 pool count: ${Object.keys(pools_v3).length}`);
    let pools = Object.values(pools_v2).concat(Object.values(pools_v3));

    const tokenPools = {}; // Finds at least one pool for each token
    // Build a list of all the tokens found. For each token, store one pool object.
    for (const pool of Object.values(pools)) {
        // Only add the pool if it involves wmatic. Store the corresponding token.
        if (pool.token0 == WMATIC) {
            tokenPools[pool.token1] = pool;
        } else if (pool.token1 == WMATIC) {
            tokenPools[pool.token0] = pool;
        }
    }

    // Read list of valid tokens from file
    console.log('Reading valid tokens from file...');
    let filteredTokenInfo = JSON.parse(
        fs.readFileSync('data/dump_token_info.json', 'utf8')
    );
    console.log('Valid token count: ', Object.keys(filteredTokenInfo).length);
    

    // Make an eth_call to the tokenTools contract to get the pool info
    const poolListFull = [];
    const tokenListFull = [];
    // Only store tokens that are both in tokenPools and filteredTokenInfo (intersection of the two sets)
    for (const token of Object.keys(filteredTokenInfo)) {
        if (tokenPools[token]) {
            poolListFull.push(tokenPools[token]['address']);
            tokenListFull.push(token);
        }
    }

    console.log('Pool list count: ', poolListFull.length);
    console.log('Token list count: ', tokenListFull.length);

    console.log('Pool List saved to file.');
    fs.writeFileSync(
        'contracts/forge/external/pools.json',
        JSON.stringify(poolListFull),
        'utf8'
    );

    console.log('Token List saved to file.');
    fs.writeFileSync(
        'contracts/forge/external/tokens.json',
        JSON.stringify(tokenListFull),
        'utf8'
    );
}

dumpTokens();
