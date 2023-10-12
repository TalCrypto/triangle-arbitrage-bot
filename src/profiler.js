// This script performs various measurements on the rpc endpoints.
const ethers = require('ethers');
const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    HTTP_ENDPOINTS,
    WSS_ENDPOINTS,
} = require('./constants');


// Check if the rpc endpoints are working correctly, then perform a block latency analysis.
async function profileBlockArrivals(probeDuration = 5 * 60 * 1000) { // 5 minutes * 60 seconds * 1000 ms
    async function checkProvider(providerUrl) {
        let provider;

        try {
            if (providerUrl.startsWith('http')) {
                provider = new ethers.providers.JsonRpcProvider(providerUrl);
            } else if (providerUrl.startsWith('ws')) {
                provider = new ethers.providers.WebSocketProvider(providerUrl);

                provider.on('error', (error) => {
                    throw new Error(`Caught WS error: ${error.message}`);
                });
            } else {
                throw new Error(`Invalid URL format: ${providerUrl}`);
            }
            await provider.getBlockNumber();
            console.log(`${providerUrl} is working correctly.`);
            
        } catch (error) {
            console.error(`Provider ${providerUrl} is not working correctly. Error: ${error.message}`);
        } 
        
    }

    // Check if the rpc endpoints are working correctly
    HTTP_ENDPOINTS.push(HTTPS_URL); // Merge with main RPCs. Find better interface
    HTTP_ENDPOINTS.push(HTTPS2_URL);
    WSS_ENDPOINTS.push(WSS_URL);
    let providers = HTTP_ENDPOINTS.concat(WSS_ENDPOINTS);
    console.log(`Checking if the ${providers.length} providers are working correctly...`);
    await Promise.all(providers.map(providerUrl => checkProvider(providerUrl)));
    console.log("Done checking providers.");

    // For each block, for each provider, store the time it took to get the block
    let blockProviderTime = {};
    let providerBlockTime = {};
    let providerRequestDuration = {};
    let runningHttpProviderCount = 0;
    let runningWsProviderCount = 0;

    async function probeHttpProviders(probeDuration) {
        console.log(`Probing HTTP providers for ${probeDuration / 1000 / 60} minutes.`)

        // For 5 minutes, for each provider, every 200ms get the block number
        for (const providerUrl of HTTP_ENDPOINTS) {
            // Build a loop that runs for 5 minutes for each provider.
            // Every 200ms, or everytime the request returns, whichever is longer, get the block number.
            const provider = new ethers.providers.JsonRpcProvider(providerUrl);

            // Save the time before the loop starts
            const t0 = new Date().getTime();

            // Use setTimeout to run the probe function every 200ms
            const probeFunction = async () => {
                const tStart = new Date().getTime();

                // Check if the 5 minutes have passed
                if (tStart - t0 > probeDuration) {
                    runningHttpProviderCount--;
                    return;
                }

                // Fetch block, save time and initiate the next probe
                try {
                    const blockNumber = await provider.getBlockNumber();
                    let tEnd = new Date().getTime();
                    if(!blockProviderTime[providerUrl]) {
                        blockProviderTime[providerUrl] = tEnd;
                        providerBlockTime[blockNumber] = tEnd;
                        providerRequestDuration[providerUrl] = tEnd - tStart;

                    } else if (blockProviderTime[providerUrl] > tEnd) {
                        console.log(`Error: Block regression detected ! Provider ${providerUrl} | Block ${blockNumber} | Time saved ${blockProviderTime[providerUrl]} | Time now ${tEnd}`);
                    }

                    console.log(`Provider ${providerUrl} | Block ${blockNumber} | Time: ${tEnd - tStart}ms`);

                    // If the request took less than 200ms, wait the remaining time, then call.
                    if (tEnd - tStart < 200) {
                        setTimeout(probeFunction, 200 - (tEnd - tStart));
                    } else {
                        probeFunction();
                    }
                } catch (error) {
                    // Failure. Wait full 200ms and call again.
                    console.log(`Provider ${providerUrl} is not working correctly. Error: ${error.message}`);
                    setTimeout(probeFunction, 200);
                }
            }
            
            probeFunction();
            runningHttpProviderCount++;
        }
    }

    async function listenWsProviders(probeDuration) {
        console.log(`Probing WS providers for ${probeDuration / 1000 / 60} minutes.`)

        for (const providerUrl of WSS_ENDPOINTS) {
            console.log(`Setting up WSS provider ${providerUrl}`);

            let provider = new ethers.providers.WebSocketProvider(providerUrl);
            const t0 = new Date().getTime();
        
            provider.on('block', (blockNumber) => {
                let t1 = new Date().getTime();
        
                if(!blockProviderTime[providerUrl]) {
                    blockProviderTime[providerUrl] = t1;
                    providerBlockTime[blockNumber] = t1;
                    
                } else if(blockProviderTime[providerUrl] > t1) {
                    console.log(`Error: Block regression detected ! Provider ${providerUrl} | Block ${blockNumber} | Time saved ${blockProviderTime[providerUrl]} | Time now ${t1}`);
                }

                console.log(`WSS Provider ${providerUrl} | Block ${blockNumber} | Time: ${t1 - t0}ms`);
            });

            provider.on('error', (error) => {
                console.error(`ERROR: WSS Provider ${providerUrl} is not working correctly. Error: ${error.message}`);
            });

            setTimeout(() => {
                provider.removeAllListeners('block');
                provider.removeAllListeners('error');
                // provider.disconnect();
                provider.destroy();
                runningWsProviderCount--;
            }, probeDuration);

            runningWsProviderCount++;
        }
    }

    setInterval(function() {
        console.log("--------- Block Latency Report ----------");
        // For each block, check if all providers have reported the block. Then store the average latency compared to the first block arrival.
        let blockNumbers = Object.keys(blockProviderTime);
        let providerUrls = Object.keys(providerBlockTime);

        let blockArrivals = {};
        let sumLatency = {};
        let blockCount = {};

        for (const blockNumber of blockNumbers) {
            // Find the first provider that has reported the block
            let arrivals = [];
            for (const providerUrl of providerUrls) {
                if (providerBlockTime[providerUrl][blockNumber]) {
                    arrivals.push(providerBlockTime[providerUrl][blockNumber]);
                }
            }
            arrivals.sort();
            blockArrivals[blockNumber] = arrivals;

            // Calculate the average latency for each provider
            for (const providerUrl of providerUrls) {
                if (providerBlockTime[providerUrl][blockNumber]) {
                    if (!sumLatency[providerUrl]) {
                        sumLatency[providerUrl] = 0;
                        blockCount[providerUrl] = 0;
                    }
                    sumLatency[providerUrl] += providerBlockTime[providerUrl][blockNumber] - blockArrivals[blockNumber][0];
                    blockCount[providerUrl]++;
                }
            }
        }
        
        // Print the average latency for each provider
        console.log("=== Individual provider latency ===")
        for (const providerUrl of providerUrls) {
            console.log(`Provider ${providerUrl} | Average latency: ${sumLatency[providerUrl] / blockCount[providerUrl]} ms`);
        }

        // Print the distribution (deciles) of block arrivals over all the blocks
        console.log("=== Block arrival distribution ===")
        let blockArrivalsArray = [];
        for (const blockNumber of blockNumbers) {
            for (const arrival of blockArrivals[blockNumber]) {
                blockArrivalsArray.push(arrival);
            }
        }
        blockArrivalsArray.sort();
        const N = 10;
        for (let i = 0; i < N; i++) {
            console.log(`Block arrival ${i * 10}%: ${blockArrivalsArray[Math.floor(blockArrivalsArray.length * i / N)]}`);
        }


    }, 1000*10); // Print latency every 10 seconds
    
    probeHttpProviders(probeDuration);
    // listenWsProviders(probeDuration);
}

module.exports = {
    profileBlockArrivals,
}