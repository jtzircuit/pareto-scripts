#!/usr/bin/env node
/**
 * backfill-price.js
 *
 * Discover and backfill vault/tranche share price data into CSV.
 * Supports direct contract addresses or any URL containing an address.
 *
 * Usage:
 *   node scripts/backfill-price.js --vault <url_or_address> [--chain ethereum|base] [--block-step 7200] [--out file.csv]
 *
 * The script auto-discovers:
 *   - Token or vault contract from input URL/address
 *   - Price function (priceAA, price, convertToAssets, etc.)
 *   - Deployment block for backfill range
 *   - Share decimals (for ERC4626 vaults)
 */

import fs from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";

import { NETWORKS } from "../lib/config.js";
import {
  parseArgs,
  parseDateToUnixSeconds,
  extractAddress,
  normalizeChainKey,
  inferChainKey,
  tryCall,
} from "../lib/utils.js";
import { initializeProviderPool, rpcCall, getBlockByTime, getDeployBlock, getProviderPoolInfo } from "../lib/provider.js";
import { discoverPriceSource, getAbiForAddress } from "../lib/discovery.js";

dotenv.config();

const ENV_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || process.env.VAULT_ADDRESS;

/**
 * Helper to build RPC URL list from various environment sources
 * @private
 */
function buildRpcUrls(opts, chainKey, chainCfg) {
  const fromArgs = (opts.rpcUrls || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const chainEnvPrefix = chainKey.toUpperCase();
  const fromChainEnvList = (process.env[`${chainEnvPrefix}_RPC_URLS`] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromChainEnvSingle = (process.env[`${chainEnvPrefix}_RPC_URL`] || "").trim();
  const fromEnvList = (process.env.RPC_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fromEnvSingle = (process.env.RPC_URL || "").trim();

  const all = [
    ...fromArgs,
    ...fromChainEnvList,
    ...(fromChainEnvSingle ? [fromChainEnvSingle] : []),
    ...fromEnvList,
    ...(fromEnvSingle ? [fromEnvSingle] : []),
    ...chainCfg.rpcUrls,
  ];

  const unique = [];
  const seen = new Set();
  for (const url of all) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

/**
 * Read price at specified block
 * @private
 */
async function readPriceAtBlock(discovery, block) {
  if (discovery.mode === "direct") {
    const abiSig = `function ${discovery.sourceFunction}() view returns (uint256)`;
    const res = await tryCall(
      discovery.sourceAddress,
      abiSig,
      discovery.sourceFunction,
      [],
      block
    );
    if (!res.ok) throw new Error(`failed to read ${discovery.sourceFunction} at block ${block}`);
    return res.value;
  }
  if (discovery.mode === "erc4626") {
    const res = await tryCall(
      discovery.sourceAddress,
      "function convertToAssets(uint256) view returns (uint256)",
      "convertToAssets",
      [discovery.oneShare],
      block
    );
    if (!res.ok) throw new Error(`failed to read convertToAssets at block ${block}`);
    return res.value;
  }
  throw new Error(`unsupported mode: ${discovery.mode}`);
}

/**
 * Main entry point: discover and backfill vault share price history
 */
async function main() {
  const schemaMap = {
    vault: "string",
    contractAddress: "string",
    priceFn: "string",
    startDate: "string",
    endDate: "string",
    startBlock: "number",
    endBlock: "number",
    blockStep: "number",
    outfile: "string",
    discoverOnly: "boolean",
    rpcUrls: "string",
    chain: "string",
  };
  const opts = parseArgs(process.argv.slice(2), schemaMap);

  const rawTarget = opts.vault || opts.contractAddress || ENV_CONTRACT_ADDRESS;
  const inputAddress = extractAddress(rawTarget);
  if (!inputAddress) {
    console.error("provide --vault <url_or_address> or --contract-address <address> (or set CONTRACT_ADDRESS/VAULT_ADDRESS in .env)");
    process.exit(1);
  }

  const chainKey = normalizeChainKey(opts.chain) || inferChainKey(rawTarget) || "ethereum";
  const chainCfg = NETWORKS[chainKey];
  if (!chainCfg) {
    throw new Error(`unsupported chain: ${chainKey}; supported: ${Object.keys(NETWORKS).join(", ")}`);
  }

  const rpcUrls = buildRpcUrls(opts, chainKey, chainCfg);
  initializeProviderPool(rpcUrls);

  const network = await rpcCall((p) => p.getNetwork());
  if (network.chainId !== BigInt(chainCfg.chainId)) {
    throw new Error(
      `rpc/network mismatch: expected chainId ${chainCfg.chainId} (${chainKey}) got ${network.chainId.toString()}`
    );
  }

  const discovery = await discoverPriceSource(inputAddress, opts);
  const sourceAddress = discovery.sourceAddress;

  await getAbiForAddress(sourceAddress, chainCfg);

  const latestBlock = await rpcCall((p) => p.getBlockNumber());
  const deployBlock = await getDeployBlock(sourceAddress);
  const deployMeta = await rpcCall((p) => p.getBlock(deployBlock));

  let startBlock = opts.startBlock;
  let endBlock = opts.endBlock;

  if (opts.startDate) startBlock = await getBlockByTime(parseDateToUnixSeconds(opts.startDate), 0, latestBlock);
  if (opts.endDate) endBlock = await getBlockByTime(parseDateToUnixSeconds(opts.endDate), 0, latestBlock);

  if (startBlock == null) startBlock = deployBlock;
  if (endBlock == null) endBlock = latestBlock;

  if (startBlock < deployBlock) {
    console.warn(`start block ${startBlock} is before source deployment block ${deployBlock}; clamping to deploy block`);
    startBlock = deployBlock;
  }
  if (endBlock < startBlock) throw new Error(`end block ${endBlock} is less than start block ${startBlock}`);

  console.log(`rpc pool (${rpcUrls.length}): ${rpcUrls.join(", ")}`);
  console.log(`input address: ${inputAddress}`);
  if (discovery.minterAddress) console.log(`resolved minter: ${discovery.minterAddress}`);
  if (discovery.tokenSymbol) console.log(`token symbol: ${discovery.tokenSymbol}`);
  console.log(`source contract: ${sourceAddress}`);
  console.log(`source mode: ${discovery.mode}`);
  console.log(`source function: ${discovery.sourceFunction}`);
  console.log(`source deploy block: ${deployBlock} (${new Date(Number(deployMeta.timestamp) * 1000).toISOString()})`);
  console.log(`range blocks: ${startBlock} -> ${endBlock}`);

  if (opts.discoverOnly) return;

  const blockStep = Number.isFinite(opts.blockStep) && opts.blockStep > 0 ? opts.blockStep : null;
  if (blockStep) console.log(`using fast block-step mode: ${blockStep}`);

  const outfile = opts.outfile || "price-history.csv";
  const stream = fs.createWriteStream(outfile, { flags: "w" });
  const networkLabel = `${chainKey}:${network.chainId.toString()}`;
  stream.write("date,block,price\n");

  let lastDate = "";
  let firstTs = null;
  let lastTs = null;
  let firstPrice = null;
  let lastPrice = null;
  for (let block = startBlock; block <= endBlock; ) {
    const blk = await rpcCall((p) => p.getBlock(block));
    const price = await readPriceAtBlock(discovery, block);
    const date = new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 10);

    if (date !== lastDate) {
      stream.write(`${date},${block},${price.toString()}\n`);
      if (firstTs === null) {
        firstTs = Number(blk.timestamp);
        firstPrice = Number(price);
      }
      lastTs = Number(blk.timestamp);
      lastPrice = Number(price);
      lastDate = date;
    }

    if (blockStep) {
      if (block === endBlock) break;
      const nextBlock = Math.min(block + blockStep, endBlock);
      if (nextBlock <= block) break;
      block = nextBlock;
      continue;
    }

    const nextTs = Number(blk.timestamp) + 24 * 3600;
    const nextBlock = await getBlockByTime(nextTs, block + 1, endBlock);
    if (nextBlock <= block) break;
    block = nextBlock;
  }

  const days =
    firstTs != null && lastTs != null ? Math.max(1, Math.round((lastTs - firstTs) / 86400)) : 0;
  let avgAprPct = "n/a";
  if (
    Number.isFinite(firstPrice) &&
    Number.isFinite(lastPrice) &&
    firstPrice > 0 &&
    lastPrice > 0 &&
    days > 0
  ) {
    const apr = (Math.pow(lastPrice / firstPrice, 365 / days) - 1) * 100;
    avgAprPct = `${apr.toFixed(4)}%`;
  }

  stream.write("\n# Summary\n");
  stream.write(`# Days: ${days}\n`);
  stream.write(`# Average APR: ${avgAprPct}\n`);
  stream.write(`# Method: ${discovery.sourceFunction}\n`);
  stream.write(`# Network: ${networkLabel}\n`);
  stream.write(`# Explorer: ${chainCfg.explorer}\n`);
  stream.end();
  console.log(`output written to ${outfile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
