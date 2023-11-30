const { ethers } = require('ethers');
const EventEmitter = require('events');
const WebSocket = require('ws');

const {
    HTTPS_URL,
    HTTPS2_URL,
    WSS_URL,
    PRIVATE_KEY,
    TRADE_CONTRACT_ABI,
    SENDER_ADDRESS,
    TRADE_CONTRACT_ADDRESS,
    SAFE_TOKENS,
    CHAIN_ID,
    HTTP_ENDPOINTS,
    WS_BDN_GATEWAY,
    HTTP_LOCAL_URL,
    BDN_AUTH_KEY
} = require('./constants');

const { logger } = require('./constants');
const { keepPoolsWithLiquidity, extractPoolsFromPaths, indexPathsByPools, preSelectPaths } = require('./pools');
const { generatePaths } = require('./paths');
const { batchReserves } = require('./multi');
const { streamNewBlocks } = require('./streams');
const { findUpdatedPools, clipBigInt, displayStats } = require('./utils');
const { exactTokensOut, computeProfit, optimizeAmountIn } = require('./simulator');
const { buildTx, buildBlankTx } = require('./bundler');
const fs = require('fs');
const path = require('path');


async function main() {
    logger.info("Program started");
    const localProvider = new ethers.providers.JsonRpcProvider(HTTP_LOCAL_URL);
    let sessionStart = new Date();
    let lastGasPrice = await localProvider.getGasPrice();
    let lastTxCount = await localProvider.getTransactionCount(SENDER_ADDRESS);
    let lastBlockNumber = await localProvider.getBlockNumber(); // Used to abandon old blocks, when a new one is received.

    async function handleNewBlock(blockData) {
        const blockJsonData = JSON.parse(blockData.toString());
        if(!blockJsonData.params) return;
        const blockNumber = Number(blockJsonData.params.result.header.number);
        const blockTimestamp = Number(blockJsonData.params.result.header.timestamp);
        let sblock = new Date();
        console.log(blockTimestamp);
        console.log(parseInt(sblock/ 1000));

        // Old block guard
        if (blockNumber <= lastBlockNumber) { 
            // We have already processed this block, or an older one. Ignore it.
            logger.info(`Ignoring old block #${blockNumber} (latest block is #${lastBlockNumber})`);
            return;
        } else {
            // We are currently processing the latest block
            lastBlockNumber = blockNumber;
        }

        // Pre-fetch the gas price and tx count for the new block
        let pricePromise = localProvider.getGasPrice();
        pricePromise.then((price) => {
            lastGasPrice = price;
        });
        let txPromise = localProvider.getTransactionCount(SENDER_ADDRESS);
        txPromise.then((txCount) => {
            lastTxCount = txCount;
        });
        

        try {
            logger.info(`=== New Block #${blockNumber}`);



            // Check if we are still working on the latest block
            if (blockNumber < lastBlockNumber) {
                logger.info(`New block mined (${lastBlockNumber}), skipping block #${blockNumber}`);
                return;
            }


            let elapsed = new Date() - sblock;


            elapsed = new Date() - sblock;
            
            // The promises should have long resolved by now, grab the values.
            await Promise.all([pricePromise, txPromise]);


            // Send arbitrage transaction
            logger.info(`!!!!!!!!!!!!! Sending arbitrage transaction... Should land in block #${blockNumber + 1} `);

            // Create a signer
            const signer = new ethers.Wallet(PRIVATE_KEY);
            const account = signer.connect(localProvider);
            const tradeContract = new ethers.Contract(TRADE_CONTRACT_ADDRESS, TRADE_CONTRACT_ABI, account);

            // Use JSON-RPC instead of ethers.js to send the signed transaction
            let tipPercent = 1000;
            let start = Date.now();
            let txObject = await buildBlankTx(signer, lastTxCount, lastGasPrice, tipPercent, blockNumber + 1);
            
            // Send the transaction via bloXroute
            const wsTxBDN = new WebSocket(WS_BDN_GATEWAY, {
                headers: {
                    "Authorization": BDN_AUTH_KEY
                }
            });

            function proceed() {
                wsTxBDN.send(`{"jsonrpc": "2.0", "id": 1, "method": "blxr_tx", "params": {"transaction": "${txObject}"}}`)
            }
            
            function handle(response) {
                wsTxBDN.terminate();
            }

            wsTxBDN.on('open', proceed);
            wsTxBDN.on('message', handle);

            await localProvider.send("eth_sendRawTransaction", txObject);
            lastTxCount++;

            logger.info(`Finished sending. End-to-end delay ${(Date.now() - sblock) / 1000} s after block #${blockNumber}`);
            // await Promise.all(promises);
            // logger.info(`Successfully received by ${successCount} endpoints. E2E ${(Date.now() - start) / 1000} s. Tx hash ${await promises[0]} Block #${blockNumber}`);
            // lastTxCount++;

        } catch (e) {
            logger.error(`Error while processing block #${blockNumber}: ${e}`);
        } finally {
            let blockElapsed = new Date() - sblock;
            logger.info(`=== End of block #${blockNumber} (took ${(blockElapsed) / 1000} s)`);
        }
    }

    function proceedNewBlockSubscription() {
        wsBDN.send(`{"jsonrpc": "2.0", "id": 1, "method": "subscribe", "params": ["newBlocks", {"include": ["header"]}]}`);
    }

    const wsBDN = new WebSocket(WS_BDN_GATEWAY, {
        headers: {
            "Authorization": BDN_AUTH_KEY
        }
    });

    // start subscription to listen to new blocks
    wsBDN.on('open', proceedNewBlockSubscription);
    wsBDN.on('message', handleNewBlock);
}

main();