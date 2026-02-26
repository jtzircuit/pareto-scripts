#!/usr/bin/env node
/*
 * backfill-price.js
 *
 * Discover and backfill vault/tranche share price data into CSV.
 * Supports direct contract addresses or Pareto app URLs, and can auto-resolve
 * tranche token -> minter proxy workflows common in Pareto vaults.
 */

import fs from "fs";
import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com/";
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ENV_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || process.env.VAULT_ADDRESS;

if (!RPC_URL) {
  console.error("RPC_URL must be set in env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 500;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--vault":
        out.vault = args[++i];
        break;
      case "--contract-address":
        out.contractAddress = args[++i];
        break;
      case "--price-fn":
        out.priceFn = args[++i];
        break;
      case "--start-date":
        out.startDate = args[++i];
        break;
      case "--end-date":
        out.endDate = args[++i];
        break;
      case "--start-block":
        out.startBlock = parseInt(args[++i], 10);
        break;
      case "--end-block":
        out.endBlock = parseInt(args[++i], 10);
        break;
      case "--block-step":
        out.blockStep = parseInt(args[++i], 10);
        break;
      case "--out":
        out.outfile = args[++i];
        break;
      case "--discover-only":
        out.discoverOnly = true;
        break;
      default:
        console.warn(`unknown argument ${a}`);
    }
  }
  return out;
}

function parseDateToUnixSeconds(dateStr) {
  const iso = `${dateStr}T00:00:00Z`;
  const ts = Math.floor(new Date(iso).getTime() / 1000);
  if (!Number.isFinite(ts)) throw new Error(`invalid date: ${dateStr}`);
  return ts;
}

function extractAddress(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (ethers.isAddress(trimmed)) return ethers.getAddress(trimmed);

  const m = trimmed.match(/0x[a-fA-F0-9]{40}/);
  if (m && ethers.isAddress(m[0])) return ethers.getAddress(m[0]);
  return null;
}

async function getBlockByTime(targetTs, low = 0, high = null) {
  if (high === null) high = await provider.getBlockNumber();
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const block = await rpcWithRetry(() => provider.getBlock(mid));
    if (Number(block.timestamp) <= targetTs) low = mid;
    else high = mid - 1;
  }
  return low;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableRpcError(err) {
  const msg = `${err?.shortMessage || ""} ${err?.message || ""}`.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("timeout") ||
    msg.includes("temporar") ||
    msg.includes("overflow") ||
    msg.includes("cannot fulfill request") ||
    msg.includes("server response")
  );
}

async function rpcWithRetry(fn, retries = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableRpcError(err) || i === retries - 1) throw err;
      await sleep(RETRY_DELAY_MS * (i + 1));
    }
  }
  throw lastErr;
}

async function getDeployBlock(address) {
  const latest = await rpcWithRetry(() => provider.getBlockNumber());
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await rpcWithRetry(() => provider.getCode(address, mid));
    if (code && code !== "0x") high = mid;
    else low = mid + 1;
  }
  return low;
}

async function tryCall(address, abiSig, fnName, args = [], blockTag = "latest") {
  try {
    const c = new ethers.Contract(address, [abiSig], provider);
    const v = await rpcWithRetry(() => c[fnName](...args, { blockTag }));
    return { ok: true, value: v };
  } catch {
    return { ok: false };
  }
}

async function resolveMinter(tokenAddress, blockTag = "latest") {
  const res = await tryCall(
    tokenAddress,
    "function minter() view returns (address)",
    "minter",
    [],
    blockTag
  );
  if (!res.ok) return null;
  const candidate = res.value;
  if (!ethers.isAddress(candidate)) return null;
  const checksum = ethers.getAddress(candidate);
  const code = await rpcWithRetry(() => provider.getCode(checksum, blockTag));
  if (!code || code === "0x") return null;
  return checksum;
}

async function resolveTokenSymbol(tokenAddress, blockTag = "latest") {
  const res = await tryCall(tokenAddress, "function symbol() view returns (string)", "symbol", [], blockTag);
  if (!res.ok || typeof res.value !== "string") return null;
  return res.value;
}

function preferredFunctionsFromSymbol(symbol) {
  const standard = ["priceAA", "priceBB", "price", "tokenPrice", "tranchePrice", "pricePerShare", "getPricePerFullShare"];
  if (!symbol) return standard;
  const s = symbol.toUpperCase();
  if (s.includes("AA")) return ["priceAA", ...standard.filter((x) => x !== "priceAA")];
  if (s.includes("BB")) return ["priceBB", ...standard.filter((x) => x !== "priceBB")];
  return standard;
}

async function discoverPriceSource(inputAddress, opts) {
  const latest = await provider.getBlockNumber();
  const tokenSymbol = await resolveTokenSymbol(inputAddress, latest);
  const minter = await resolveMinter(inputAddress, latest);

  const candidates = [];
  if (minter) candidates.push({ address: minter, hint: "minter" });
  candidates.push({ address: inputAddress, hint: "input" });

  const functionOrder = opts.priceFn ? [opts.priceFn] : preferredFunctionsFromSymbol(tokenSymbol);

  for (const c of candidates) {
    for (const fn of functionOrder) {
      const sig = `function ${fn}() view returns (uint256)`;
      const probe = await tryCall(c.address, sig, fn, [], latest);
      if (probe.ok) {
        return {
          sourceAddress: c.address,
          sourceFunction: fn,
          mode: "direct",
          tokenAddress: inputAddress,
          tokenSymbol,
          minterAddress: minter,
        };
      }
    }
  }

  // ERC4626 fallback
  for (const c of candidates) {
    const dec = await tryCall(c.address, "function decimals() view returns (uint8)", "decimals", [], latest);
    if (!dec.ok) continue;
    const decimals = Number(dec.value);
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 30) continue;
    const oneShare = 10n ** BigInt(decimals);
    const probe = await tryCall(
      c.address,
      "function convertToAssets(uint256) view returns (uint256)",
      "convertToAssets",
      [oneShare],
      latest
    );
    if (probe.ok) {
      return {
        sourceAddress: c.address,
        sourceFunction: "convertToAssets",
        mode: "erc4626",
        oneShare,
        shareDecimals: decimals,
        tokenAddress: inputAddress,
        tokenSymbol,
        minterAddress: minter,
      };
    }
  }

  throw new Error(
    `could not discover price source for ${inputAddress}; tried candidates: ${candidates
      .map((c) => c.address)
      .join(", ")}`
  );
}

async function fetchAbiFromEtherscan(address) {
  if (!ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY not set");
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
  const resp = await axios.get(url);
  if (resp.data.status !== "1") throw new Error(resp.data.result || "etherscan abi lookup failed");
  return JSON.parse(resp.data.result);
}

async function fetchAbiFromSourcify(address) {
  const endpoints = [
    `https://repo.sourcify.dev/contracts/full_match/1/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/1/${address}/metadata.json`,
  ];
  for (const url of endpoints) {
    try {
      const resp = await axios.get(url, { timeout: 10000 });
      if (resp.data?.output?.abi) return resp.data.output.abi;
    } catch {
      // continue
    }
  }
  throw new Error("sourcify abi lookup failed");
}

async function getAbiForAddress(address) {
  try {
    const abi = await fetchAbiFromEtherscan(address);
    console.log("fetched ABI from Etherscan");
    return abi;
  } catch {
    // fallback
  }

  try {
    const abi = await fetchAbiFromSourcify(address);
    console.log("fetched ABI from Sourcify");
    return abi;
  } catch {
    // fallback
  }

  return [
    { type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "tokenPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "tranchePrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "priceAA", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "priceBB", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    {
      type: "function",
      name: "convertToAssets",
      stateMutability: "view",
      inputs: [{ type: "uint256" }],
      outputs: [{ type: "uint256" }],
    },
  ];
}

async function readPriceAtBlock(contract, discovery, block) {
  if (discovery.mode === "direct") {
    return contract[discovery.sourceFunction]({ blockTag: block });
  }
  if (discovery.mode === "erc4626") {
    return contract.convertToAssets(discovery.oneShare, { blockTag: block });
  }
  throw new Error(`unsupported mode: ${discovery.mode}`);
}

async function main() {
  const opts = parseArgs();
  const rawTarget = opts.vault || opts.contractAddress || ENV_CONTRACT_ADDRESS;
  const inputAddress = extractAddress(rawTarget);
  if (!inputAddress) {
    console.error("provide --vault <url_or_address> or --contract-address <address> (or env CONTRACT_ADDRESS/VAULT_ADDRESS)");
    process.exit(1);
  }

  const network = await rpcWithRetry(() => provider.getNetwork());
  if (network.chainId !== 1n) {
    throw new Error(`unsupported chainId ${network.chainId.toString()}; this script currently assumes Ethereum mainnet`);
  }

  const discovery = await discoverPriceSource(inputAddress, opts);
  const sourceAddress = discovery.sourceAddress;

  let readAbi;
  if (discovery.mode === "direct") {
    readAbi = [`function ${discovery.sourceFunction}() view returns (uint256)`];
  } else if (discovery.mode === "erc4626") {
    readAbi = ["function convertToAssets(uint256) view returns (uint256)"];
  } else {
    throw new Error(`unsupported discovery mode: ${discovery.mode}`);
  }
  const contract = new ethers.Contract(sourceAddress, readAbi, provider);

  const latestBlock = await rpcWithRetry(() => provider.getBlockNumber());
  const deployBlock = await getDeployBlock(sourceAddress);
  const deployMeta = await rpcWithRetry(() => provider.getBlock(deployBlock));

  let startBlock = opts.startBlock;
  let endBlock = opts.endBlock;

  if (opts.startDate) {
    const ts = parseDateToUnixSeconds(opts.startDate);
    startBlock = await getBlockByTime(ts, 0, latestBlock);
  }
  if (opts.endDate) {
    const ts = parseDateToUnixSeconds(opts.endDate);
    endBlock = await getBlockByTime(ts, 0, latestBlock);
  }

  if (startBlock == null) startBlock = deployBlock;
  if (endBlock == null) endBlock = latestBlock;

  if (startBlock < deployBlock) {
    console.warn(`start block ${startBlock} is before source deployment block ${deployBlock}; clamping to deploy block`);
    startBlock = deployBlock;
  }
  if (endBlock < startBlock) {
    throw new Error(`end block ${endBlock} is less than start block ${startBlock}`);
  }

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
  stream.write("date,block,price\n");

  let lastDate = "";
  for (let block = startBlock; block <= endBlock; ) {
    const blk = await rpcWithRetry(() => provider.getBlock(block));
    const price = await readPriceAtBlock(contract, discovery, block);
    const date = new Date(Number(blk.timestamp) * 1000).toISOString().slice(0, 10);

    if (date !== lastDate) {
      stream.write(`${date},${block},${price.toString()}\n`);
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

  stream.end();
  console.log(`output written to ${outfile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
