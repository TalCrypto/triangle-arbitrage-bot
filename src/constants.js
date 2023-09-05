const { addColors, createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize } = format;

require('dotenv').config();

const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'black',
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
        colorize({ all: true }),
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
    },
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": {
        decimals: 6, 
        symbol: "USDC",
    },
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": {
        decimals: 18, 
        symbol: "WETH",
    },
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063": {
        decimals: 18, 
        symbol: "DAI",
    },
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": {
        decimals: 18, 
        symbol: "WMATIC",
    },
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": {
        decimals: 8, 
        symbol: "WBTC",
    },
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39": {
        decimals: 18, 
        symbol: "LINK",
    },
    "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F": {
        decimals: 6, 
        symbol: "amUSDC",
    },
    "0x60D55F02A771d515e077c9C2403a1ef324885CeC": {
        decimals: 6, 
        symbol: "amUSDT",
    },
    "0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4": {
        decimals: 18, 
        symbol: "amWMATIC",
    },
    "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390": {
        decimals: 18, 
        symbol: "amWETH",
    },
    "0xE0B52e49357Fd4DAf2c15e02058DCE6BC0057db4": {
        decimals: 18, 
        symbol: "agEUR",
    },
};

module.exports = {
    // env variables
    HTTPS_URL: process.env.HTTPS_URL,
    WSS_URL: process.env.WSS_URL,
    CHAIN_ID: process.env.CHAIN_ID || 1,
    BLOCKNATIVE_TOKEN: process.env.BLOCKNATIVE_TOKEN,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    SIGNING_KEY: process.env.SIGNING_KEY,
    BOT_ADDRESS: process.env.BOT_ADDRESS,
    COINMARKETCAP_API_KEY: process.env.COINMARKETCAP_API_KEY,

    // abi
    BOT_ABI: require('../abi/V2ArbBot.json'),

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

};