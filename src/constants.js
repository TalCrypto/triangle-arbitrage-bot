const { addColors, createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize } = format;

require('dotenv').config();

const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'white',
    http: 'magenta',
    debug: 'blue',
};

addColors(colors);

const logFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level.toUpperCase()}] ${message}`;
});

// Count the number of '.log' files in /data
const fs = require('fs');
const logDir = 'data';
let logFileCount = 0;
fs.readdirSync(logDir).forEach(file => {
    if (file.endsWith('.log')) {
        logFileCount++;
    }
});

const logger = createLogger({
    format: combine(
        timestamp(),
        logFormat,
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'data/' + logFileCount + '.log' }),
    ],
});

const blacklistTokens = ['0x9469603F3Efbcf17e4A5868d81C701BDbD222555'];

// Multicall related
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL_ABI = [
    // https://github.com/mds1/multicall
    'function aggregate(tuple(address target, bytes callData)[] calls) payable returns (uint256 blockNumber, bytes[] returnData)',
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
    'function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
    'function blockAndAggregate(tuple(address target, bytes callData)[] calls) payable returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)',
    'function getBasefee() view returns (uint256 basefee)',
    'function getBlockHash(uint256 blockNumber) view returns (bytes32 blockHash)',
    'function getBlockNumber() view returns (uint256 blockNumber)',
    'function getChainId() view returns (uint256 chainid)',
    'function getCurrentBlockCoinbase() view returns (address coinbase)',
    'function getCurrentBlockDifficulty() view returns (uint256 difficulty)',
    'function getCurrentBlockGasLimit() view returns (uint256 gaslimit)',
    'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
    'function getEthBalance(address addr) view returns (uint256 balance)',
    'function getLastBlockHash() view returns (bytes32 blockHash)',
    'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
    'function tryBlockAndAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable returns (uint256 blockNumber, bytes32 blockHash, tuple(bool success, bytes returnData)[] returnData)',
];

// Tokens with more than 10M market cap
const SAFE_TOKENS = {
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F": {
        decimals: 6, 
        symbol: "USDT",
        usd: 1,
    },
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": {
        decimals: 6, 
        symbol: "USDC",
        usd: 1,
    },
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
        decimals: 18, 
        symbol: "WETH",
        usd: 1624,
    },
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063": {
        decimals: 18, 
        symbol: "DAI",
        usd: 1,
    },
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": {
        decimals: 18, 
        symbol: "WMATIC",
        usd: 0.51,
    },
    // "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": {
    //     decimals: 8, 
    //     symbol: "WBTC",
    // },
    // "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39": {
    //     decimals: 18, 
    //     symbol: "LINK",
    // },
    // "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F": {
    //     decimals: 6, 
    //     symbol: "amUSDC",
    // },
    // "0x60D55F02A771d515e077c9C2403a1ef324885CeC": {
    //     decimals: 6, 
    //     symbol: "amUSDT",
    // },
    // "0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4": {
    //     decimals: 18, 
    //     symbol: "amWMATIC",
    // },
    // "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390": {
    //     decimals: 18, 
    //     symbol: "amWETH",
    // },
    // "0xE0B52e49357Fd4DAf2c15e02058DCE6BC0057db4": {
    //     decimals: 18, 
    //     symbol: "agEUR",
    // },
};

module.exports = {
    // env variables
    HTTPS_URL: process.env.HTTPS_URL,
    HTTPS2_URL: process.env.HTTPS2_URL,
    WSS_URL: process.env.WSS_URL,
    CHAIN_ID: Number(process.env.CHAIN_ID) || 137,
    BLOCKNATIVE_TOKEN: process.env.BLOCKNATIVE_TOKEN,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    SIGNING_KEY: process.env.SIGNING_KEY,
    SENDER_ADDRESS: process.env.SENDER_ADDRESS,
    TRADE_CONTRACT_ADDRESS: process.env.TRADE_CONTRACT_ADDRESS,
    COINMARKETCAP_API_KEY: process.env.COINMARKETCAP_API_KEY,

    // abi
    TRADE_CONTRACT_ABI: require('../abi/TradeContract.json'),
    TOKEN_TOOLS_ABI: require('../abi/TokenTools.json'),

    // logging
    logger,

    // cache
    CACHED_POOLS_FILE: '.cached-pools.csv',

    // blacklist
    blacklistTokens,

    // multicall
    MULTICALL_ADDRESS,
    MULTICALL_ABI,

    // flashbots
    PRIVATE_RELAY: 'https://relay.flashbots.net',

    // coinmarketcap
    SAFE_TOKENS: SAFE_TOKENS,

    // FlashQueryV3
    FLASH_QUERY_V3_ADDRESS: '0xa5aeC6cF29e66fD47F6a05dcc0c8aCD308d80B4E',

    // List of low quality rpc endpoints that which we will propagate our transactions to.
    HTTP_ENDPOINTS: [
        'https://matic.getblock.io/c532343e-d633-4146-a312-d852eeaaea04/mainnet/',
        'https://polygon-rpc.com/',
        'https://rpc-mainnet.matic.quiknode.pro',
        'https://polygon-bor.publicnode.com',
        'https://polygon.meowrpc.com',
        'https://polygon.drpc.org',
        'https://polygon.llamarpc.com',
        'https://polygon.blockpi.network/v1/rpc/public',
        'https://rpc.ankr.com/polygon',
        'https://polygon-mainnet.public.blastapi.io',
        'https://1rpc.io/matic',
        'https://poly-rpc.gateway.pokt.network/',
        'https://polygon.publicnode.com',
        // 'https://polygon.api.onfinality.io/public',
        'https://polygon.rpc.blxrbdn.com',
        // 'https://polygon.gateway.tenderly.co',
    ],

    // List of websocket endpoints that we will use to listen for new blocks.
    WSS_ENDPOINTS: [
        'wss://matic.getblock.io/c532343e-d633-4146-a312-d852eeaaea04/mainnet/',
        'wss://polygon-bor.publicnode.com',
        'wss://polygon.drpc.org',
        'wss://polygon.drpc.org/ws',
        'wss://polygon.llamarpc.com',
        'wss://rpc-mainnet.matic.quiknode.pro',
        // 'wss://polygon.gateway.tenderly.co',
        'wss://polygon.meowrpc.com/ws',
    ],
};