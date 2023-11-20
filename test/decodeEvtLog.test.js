const { ethers } = require('ethers');
const { expect } = require('@jest/globals');

const iface = new ethers.utils.Interface([
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
])

const egV2SyncLog = {
  address: '0xbe69026ac368e0852408705a92e5701a47e7698f',
  topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
  data: '0x0000000000000000000000000000000000000000000000000000000702a4a61800000000000000000000000000000000000000000000000000006f0b5a1fb9a4'
}

const egV3SwapLog = {
  address: '0xdac8a8e6dbf8c690ec6815e0ff03491b2770255d',
  topics: ['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x000000000000000000000000c53d01d0634b41eb86b649f1b9d95a2d5119dcfe', '0x000000000000000000000000c53d01d0634b41eb86b649f1b9d95a2d5119dcfe'],
  data: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe2f79800000000000000000000000000000000000000000000000000000000001d08270000000000000000000000000000000000000000fffb94d5e87329710b615bae00000000000000000000000000000000000000000000000000378e91efced4dbfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe'
}

test('V2 Sync event log decoding test', () => {
  expect(iface.getEventTopic("Sync") === egV2SyncLog.topics[0]).toEqual(true);
  const evt = iface.decodeEventLog("Sync", egV2SyncLog.data, egV2SyncLog.topics);
  expect(evt.reserve0).toEqual(ethers.BigNumber.from("30109115928"));
  expect(evt.reserve1).toEqual(ethers.BigNumber.from("122094547351972"));
})

test('V3 Swap event log decoding test', () => {
  expect(iface.getEventTopic("Swap") === egV3SwapLog.topics[0]).toEqual(true);
  const evt = iface.decodeEventLog("Swap", egV3SwapLog.data, egV3SwapLog.topics);
  expect(evt.amount0).toEqual(ethers.BigNumber.from("-1902696"));
  expect(evt.amount1).toEqual(ethers.BigNumber.from("1902631"));
  expect(evt.sqrtPriceX96).toEqual(ethers.BigNumber.from("79222820741311993859916520366"));
  expect(evt.liquidity).toEqual(ethers.BigNumber.from("15637881163797723"));
  expect(evt.tick).toEqual(-2);
})
