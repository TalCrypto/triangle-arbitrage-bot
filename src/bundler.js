/*
ethers-provider-flashbots-bundle
is currently dependent on ethers@5.7.2
make sure to check whether you want to use ethers v5, v6
*/
const { ethers, Wallet } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
const uuid = require('uuid');
const { CHAIN_ID } = require('./constants');
const { BOT_ABI, PRIVATE_RELAY } = require('./constants');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

class Path {
    constructor(router, tokenIn, tokenOut) {
        this.router = router;
        this.tokenIn = tokenIn;
        this.tokenOut = tokenOut;
    }

    toList() {
        return [this.router, this.tokenIn, this.tokenOut];
    }
}

const Flashloan = {
    NotUsed: 0,
    Balancer: 1,
    UniswapV2: 2,
};

class Bundler {
    constructor(
        privateKey,
        signingKey,
        httpsUrl,
        botAddress
    ) {
        this.provider = new ethers.providers.JsonRpcProvider(httpsUrl);
        this.sender = new Wallet(privateKey, this.provider);
        this.signer = new Wallet(signingKey, this.provider);
        this.bot = new ethers.Contract(botAddress, BOT_ABI, this.provider);
    }

    async setup() {
        this.chainId = (await this.provider.getNetwork()).chainId;
        this.flashbots = await FlashbotsBundleProvider.create(
            this.provider,
            this.signer,
            PRIVATE_RELAY,
        );
    }

    async toBundle(transaction) {
        return [
            {
                signer: self.sender,
                transaction,
            }
        ];
    }

    async sendBundle(bundle, blockNumber) {
        // Check usage here: https://github.com/flashbots/ethers-provider-flashbots-bundle/blob/master/src/demo.ts
        const replacementUuid = uuid.v4();
        const signedBundle = await this.flashbots.signBundle(bundle);
        const targetBlock = blockNumber + 1;
        const simulation = await this.flashbots.simulate(signedBundle, targetBlock);

        if ('error' in simulation) {
            console.warn(`Simulation Error: ${simulation.error.message}`)
            return '';
        } else {
            logger.info(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`)
        }

        const bundleSubmission = await this.flashbots.sendRawBundle(signedTransactions, targetBlock, { replacementUuid });

        if ('error' in bundleSubmission) {
            throw new Error(bundleSubmission.error.message)
        }

        return [replacementUuid, bundleSubmission];
    }

    async cancelBundle(replacementUuid) {
        return await this.flashbots.cancelBundles(replacementUuid);
    }

    async waitBundle(bundleSubmission) {
        return await bundleSubmission.wait();
    }

    async sendTx(transaction) {
        const tx = await this.sender.sendTransaction(transaction);
        return tx.hash;
    }

    async _common_fields() {
        let nonce = await this.provider.getTransactionCount(this.sender.address);
        return {
            type: 2,
            chainId: this.chainId,
            nonce,
            from: this.sender.address,
        };
    }

    async transferInTx(amountIn, maxPriorityFeePerGas, maxFeePerGas) {
        return {
            ...(await this._common_fields()),
            to: this.bot.address,
            value: BigInt(amountIn),
            gasLimit: BigInt(60000),
            maxFeePerGas: BigInt(maxFeePerGas),
            maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
        };
    }

    async transferOutTx(token, maxPriorityFeePerGas, maxFeePerGas) {
        let calldata = this.bot.interface.encodeFunctionData(
            'recoverToken',
            [token]
        );
        return {
            ...(await this._common_fields()),
            to: this.bot.address,
            data: calldata,
            value: BigInt(0),
            gasLimit: BigInt(50000),
            maxFeePerGas: BigInt(maxFeePerGas),
            maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
        };
    }

    async approveTx(
        router,
        tokens,
        force,
        maxPriorityFeePerGas,
        maxFeePerGas
    ) {
        let calldata = this.bot.interface.encodeFunctionData(
            'approveRouter',
            [router, tokens, force]
        );
        return {
            ...(await this._common_fields()),
            to: this.bot.address,
            data: calldata,
            value: BigInt(0),
            gasLimit: BigInt(55000) * BigInt(tokens.length),
            maxFeePerGas: BigInt(maxFeePerGas),
            maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
        };
    }

    async orderTx(
        paths,       // array of Path class
        amountIn,
        flashloan,   // Flashloan object
        loanFrom,    // vault address
        maxPriorityFeePerGas,
        maxFeePerGas
    ) {
        let nhop = paths.length;

        let calldataTypes = ['uint', 'uint', 'address'];
        let calldataRaw = [BigInt(amountIn), flashloan, loanFrom];

        for (let i = 0; i < nhop; i++) {
            calldataTypes = calldataTypes.concat(['address', 'address', 'address']);
            calldataRaw = calldataRaw.concat(paths[i].toList());
        }

        let abiCoder = new ethers.utils.AbiCoder();
        let calldata = abiCoder.encode(calldataTypes, calldataRaw);

        return {
            ...(await this._common_fields()),
            to: this.bot.address,
            data: calldata,
            value: BigInt(0),
            gasLimit: BigInt(600000),
            maxFeePerGas: BigInt(maxFeePerGas),
            maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
        };
    }
}

async function buildTx(path, tradeContract, tokens, logger, signer, lastTxCount, lastGasPrice, tipPercent) {
    // Display info about the path. Prepare the parameters
    path.amounts = [path.amountIn.toString()];
    let amountOut = path.amountIn;
    for (let i = 0; i < path.pools.length; i++) {
        let pool = path.pools[i];
        let zfo = path.directions[i];
        let amountIn = amountOut; // Previous amountOut value
        // Instead of clipping, we subtract 1 wei to the input amount.
        // This is done to avoid the off-by-one numeric error found in the tests.
        // (JS code predicts that we get amountOut from amountIn. In actually, we get amountOut when sending amountIn + 1 wei)
        amountIn = amountIn - 1n;
        amountOut = exactTokensOut(amountIn, pool, zfo);
        // DEBUG: Clip to the millionth. To avoid tx fails due to rounding errors.
        // Should be removed since the V3 math is fixed now.
        // amountOut = clipBigInt(amountOut, 6); // Maybe clip to the 7/8th ?
        path.amounts.push(amountOut.toString());
    }

    // Print info about the path/pools/token amounts
    for (let i = 0; i < path.pools.length; i++) {
        let pool = path.pools[i];
        let zfo = path.directions[i];
        let tin = zfo ? pool.token0 : pool.token1;
        let tout = zfo ? pool.token1 : pool.token0;
        if (pool.version == 2) {
            logger.info(`pool v:${pool.version} a:${pool.address} z:${zfo} tin:${tin} (${tokens[tin].symbol}) tout:${tout} (${tokens[tout].symbol}) in:${path.amounts[i]} out:${path.amounts[i+1]} r0:${pool.extra.reserve0} r1:${pool.extra.reserve1}`);
        } else if (pool.version == 3) {
            logger.info(`pool v:${pool.version} a:${pool.address} z:${zfo} tin:${tin} (${tokens[tin].symbol}) tout:${tout} (${tokens[tout].symbol}) in:${path.amounts[i]} out:${path.amounts[i+1]} s:${pool.extra.sqrtPriceX96} l:${pool.extra.liquidity}`);
        }
    }

    // Set up the callback data for each step of the arbitrage path. Start from the last step.
    let data3 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], 
    [
        [ 
            0, // Specify a 'token transfer' action
            ethers.utils.hexlify([]) 
        ],
        path.directions[2] ? path.pools[2].token0 : path.pools[2].token1, // token2
        path.amounts[2]
    ]); // Repay pool2

    let data2 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], [ 
        [
            path.pools[2].version, // pool2 version (2 or 3)
            ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ], [path.pools[2].address, path.amounts[3], tradeContract.address, path.directions[2], data3])
        ], // Call pool2
        path.directions[1] ? path.pools[1].token0 : path.pools[1].token1, // token1
        path.amounts[1]
    ]); // Repay pool1

    // In the callback of pool0, call pool1 and repay path.amounts[0] to pool0
    let data1 = ethers.utils.defaultAbiCoder.encode(['tuple(uint, bytes)', 'address', 'uint'], [
        [
            path.pools[1].version, // pool1 version (2 or 3)
            ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ], [path.pools[1].address, path.amounts[2], tradeContract.address, path.directions[1], data2])
        ], // Call pool1
        path.directions[0] ? path.pools[0].token0 : path.pools[0].token1, // token0
        path.amounts[0]
    ]); // Repay pool0

    // Action that triggers the chain. Starts with a call to pool0.
    let initialAction = {
        actionType: path.pools[0].version, // pool0 version (2 or 3)
        rawData: ethers.utils.defaultAbiCoder.encode([ 'address', 'uint', 'address', 'bool', 'bytes' ],
            [path.pools[0].address, path.amounts[1], tradeContract.address, path.directions[0], data1])
    }; // Call pool0

    let obj = [await signer.signTransaction({
        to: tradeContract.address,
        data: tradeContract.interface.encodeFunctionData("execute", [initialAction]),
        type: 2,
        gasLimit: 1000000, // 1M gas
        maxFeePerGas: lastGasPrice.mul(100 + tipPercent).div(100),
        maxPriorityFeePerGas: lastGasPrice.mul(tipPercent).div(100),
        nonce: lastTxCount,
        chainId: CHAIN_ID,
        value: 0,
    })]

    return obj;
}

module.exports = {
    Bundler,
    Path,
    Flashloan,
    ZERO_ADDRESS,
    buildTx,
};