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

const rows = [];
let lastDate = '';
const step = 7200;
for (let block = deploy; block <= latest; block += step) {
  const b = await provider.getBlock(block);
  const date = new Date(Number(b.timestamp) * 1000).toISOString().slice(0, 10);
  if (date > endDate) break;
  if (date === lastDate) continue;
  const price = await c.priceAA({ blockTag: block });
  rows.push(`${date},${block},${price.toString()}`);
  lastDate = date;
}

const ws = fs.createWriteStream('test-fast.csv', { flags: 'w' });
ws.write('date,block,price\n');
for (const row of rows) ws.write(row + '\n');
ws.end();

console.log('proxyDeployBlock', deploy);
console.log('proxyDeployDate', new Date(Number(deployBlock.timestamp) * 1000).toISOString());
console.log('rows', rows.length);
console.log('wrote test-fast.csv');
