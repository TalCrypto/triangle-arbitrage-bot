// This script performs various measurements on the rpc endpoints.
const ethers = require('ethers');
const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    HTTPS_ENDPOINTS,
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

            let blockPromise = provider.getBlockNumber();
            const timeOut = 2000;
            let timeOutPromise = new Promise((resolve, reject) => {
                setTimeout(() => {
                    reject(new Error(`Request timed out (${timeOut}ms).) for provider ${providerUrl}`));
                }, timeOut);
            });
            await Promise.race([blockPromise, timeOutPromise]);

            console.log(`${providerUrl} is working correctly.`);

        } catch (error) {
            console.error(`Provider ${providerUrl} is not working correctly. Error: ${error.message}`);
        }

    }

    // Check if the rpc endpoints are working correctly
    let providers = HTTPS_ENDPOINTS.concat(WSS_ENDPOINTS);
    console.log(`Checking if the ${providers.length} providers are working correctly...`);
    await Promise.all(providers.map(providerUrl => checkProvider(providerUrl)));
    console.log("Done checking providers.");

    // For each block, for each provider, store the time it took to get the block
    let blockProviderTime = {};
    let providerBlockTime = {};
    let providerRequestDurations = {};
    let runningHttpProviderCount = 0;
    let runningWsProviderCount = 0;

    async function probeHttpProviders(probeDuration) {
        console.log(`Probing HTTP providers for ${probeDuration / 1000 / 60} minutes.`)

        let P = 400; // Poll period in ms
        // For 5 minutes, for each provider, every P (ms) get the block number
        for (const providerUrl of HTTPS_ENDPOINTS) {
            // Build a loop that runs for 5 minutes for each provider.
            // Every P ms, or everytime the request returns, whichever is longer, get the block number.
            // Adds P/2 ms of average latency, but ensures that the request is not sent too often.
            const provider = new ethers.providers.JsonRpcProvider(providerUrl);

            // Save the time before the loop starts
            const t0 = new Date().getTime();

            // Use setTimeout to run the probe function every P ms
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
                    if (!blockProviderTime[blockNumber]) {
                        blockProviderTime[blockNumber] = {};
                    }
                    if (!providerBlockTime[providerUrl]) {
                        providerBlockTime[providerUrl] = {};
                    }

                    if (!blockProviderTime[blockNumber][providerUrl]) {
                        blockProviderTime[blockNumber][providerUrl] = tEnd;
                        providerBlockTime[providerUrl][blockNumber] = tEnd;
                        if (!providerRequestDurations[providerUrl]) {
                            providerRequestDurations[providerUrl] = [];
                        }
                        providerRequestDurations[providerUrl].push(tEnd - tStart);

                    } else if (blockProviderTime[blockNumber][providerUrl] > tEnd) {
                        console.log(`Error: Block regression detected ! Provider ${providerUrl} | Block ${blockNumber} | Time saved ${blockProviderTime[blockNumber][providerUrl]} | Time now ${tEnd}`);
                    }

                    console.log(`Provider ${providerUrl} | Block ${blockNumber} | Time: ${tEnd - tStart}ms`);

                    // If the request took less than P ms, wait the remaining time, then call.
                    if (tEnd - tStart < P) {
                        setTimeout(probeFunction, P - (tEnd - tStart));
                    } else {
                        probeFunction();
                    }
                } catch (error) {
                    // Failure. Wait full P ms and call again.
                    console.log(`Provider ${providerUrl} is not working correctly. Error: ${error.message}`);
                    setTimeout(probeFunction, P);
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

                if (!blockProviderTime[blockNumber]) {
                    blockProviderTime[blockNumber] = {};
                }
                if (!providerBlockTime[providerUrl]) {
                    providerBlockTime[providerUrl] = {};
                }

                if (!blockProviderTime[blockNumber][providerUrl]) {
                    blockProviderTime[blockNumber][providerUrl] = t1;
                    providerBlockTime[providerUrl][blockNumber] = t1;

                } else if (blockProviderTime[blockNumber][providerUrl] > t1) {
                    console.log(`Error: Block regression detected ! Provider ${providerUrl} | Block ${blockNumber} | Time saved ${blockProviderTime[blockNumber][providerUrl]} | Time now ${t1}`);
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

    setInterval(function () {
        // If the probe is not running anymore, stop the interval
        if (runningHttpProviderCount == 0 && runningWsProviderCount == 0) {
            clearInterval(this);
            // Exit the process
            process.exit();
        }

        console.log("\n========== Latency Report ==========");
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
            arrivals.sort((a, b) => a - b);
            blockArrivals[blockNumber] = arrivals;

            // Calculate the average block propagation latency for each provider
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

        // Print the average block propagation latency for each provider
        console.log("=== Individual provider latency ===")
        let providerLatency = [];
        for (const providerUrl of providerUrls) {
            providerLatency.push([providerUrl, Math.round(sumLatency[providerUrl] / blockCount[providerUrl])]);
        }
        providerLatency.sort((a, b) => a[1] - b[1]);
        for (const [providerUrl, latency] of providerLatency) {
            console.log(`Average latency: ${latency} ms | Provider ${providerUrl}`);
        }

        // Print the distribution (deciles) of block arrivals over all the blocks
        console.log("=== Block arrival distribution (percentiles) ===")
        const N = 10;
        let blockArrivalsArray = [];
        for (const blockNumber of blockNumbers) {
            for (const arrival of blockArrivals[blockNumber]) {
                blockArrivalsArray.push(arrival - blockArrivals[blockNumber][0]);
            }
        }
        blockArrivalsArray.sort((a, b) => a - b);
        console.log(`Distribution of block arrivals over ${blockArrivalsArray.length} blocks (${N} percentiles):`);
        let percentiles = [];
        for (let i = 0; i < N; i++) {
            percentiles.push(blockArrivalsArray[Math.floor(blockArrivalsArray.length * i / N)]);
        }
        console.log(percentiles);


        // Print the average request duration for each provider
        console.log("=== http providers request duration (eth_getBlockByNumber) ===")
        // Use providerRequestDurations
        for (const providerUrl of Object.keys(providerRequestDurations)) {
            let avg = providerRequestDurations[providerUrl].reduce((a, b) => a + b, 0) / providerRequestDurations[providerUrl].length;
            console.log(`Average request duration: ${Math.round(avg)} ms | Provider ${providerUrl}`);
        }

        console.log("====================================\n");
    }, 1000 * 10); // Print latency every 10 seconds

    probeHttpProviders(probeDuration);
    listenWsProviders(probeDuration);
}

async function profileMempool(wssUrl, numBlocks) {
    const wssProvider = new ethers.providers.WebSocketProvider(wssUrl);
    let pendingTransactions = [];
    let blocks = 0
    let numTotalMinedTx = 0;
    let numTotalMemedTx = 0;

    wssProvider.on("block", async (blockNumber) => {
        if (blocks == 0 || blocks == 1 || blocks == 2) {
            blocks++;
            // ignore the first 3 block
            return;
        }
        if (blocks == Number(numBlocks) + 3) {
            console.log(`Total mined tx: ${numTotalMinedTx}`);
            console.log(`Total tx from mempool: ${numTotalMemedTx}`);
            console.log(`Mempool accuracy: ${(numTotalMemedTx / numTotalMinedTx * 100).toFixed(2)}%`)
            process.exit(0);
        }
        const blockData = await wssProvider.getBlock(blockNumber);
        const minedTxs = blockData.transactions.map(tx => tx.toLocaleLowerCase());
        const numMinedTx = minedTxs.length;
        const numMemedTx = minedTxs.filter(tx => pendingTransactions.includes(tx)).length;
        numTotalMinedTx += numMinedTx;
        numTotalMemedTx += numMemedTx;
        console.log(`#block ${blockNumber} - num tx from mempool / num tx mined: ${numMemedTx}/${numMinedTx}`);
        blocks++;
    });

    wssProvider.on("pending", async (pendingTx) => {
        const txnData = await wssProvider.getTransaction(pendingTx);
        if (!txnData) return;
        pendingTransactions = pendingTransactions.concat([pendingTx.toLocaleLowerCase()]);
    })
}

module.exports = {
    profileBlockArrivals,
    profileMempool
}