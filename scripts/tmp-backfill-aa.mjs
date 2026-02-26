import fs from 'fs';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com/');
const proxy = '0x9cF358aff79DeA96070A85F00c0AC79569970Ec3';
const c = new ethers.Contract(proxy, ['function priceAA() view returns (uint256)'], provider);

const latest = await provider.getBlockNumber();

let lo = 0;
let hi = latest;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const code = await provider.getCode(proxy, mid);
  if (code && code !== '0x') hi = mid;
  else lo = mid + 1;
}

const deploy = lo;
const deployBlock = await provider.getBlock(deploy);

const endDate = '2026-02-26';
const endTs = Math.floor(new Date(endDate + 'T00:00:00Z').getTime() / 1000);

async function getBlockByTime(targetTs, low, high) {
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const b = await provider.getBlock(mid);
    if (Number(b.timestamp) <= targetTs) low = mid;
    else high = mid - 1;
  }
  return low;
}

const endBlock = await getBlockByTime(endTs, deploy, latest);

const ws = fs.createWriteStream('test.csv', { flags: 'w' });
ws.write('date,block,price\n');

let block = deploy;
while (block <= endBlock) {
  const b = await provider.getBlock(block);
  const price = await c.priceAA({ blockTag: block });
  const date = new Date(Number(b.timestamp) * 1000).toISOString().slice(0, 10);
  ws.write(date + ',' + block + ',' + price.toString() + '\n');

  const nextTs = Number(b.timestamp) + 24 * 3600;
  const nextBlock = await getBlockByTime(nextTs, block + 1, endBlock);
  if (nextBlock <= block) break;
  block = nextBlock;
}

ws.end();

console.log('proxyDeployBlock', deploy);
console.log('proxyDeployDate', new Date(Number(deployBlock.timestamp) * 1000).toISOString());
console.log('endBlock', endBlock);
console.log('wrote test.csv');
