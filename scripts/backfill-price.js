#!/usr/bin/env node
/*
 * backfill-price.js
 *
 * Query the share price of a vault/tranche contract at daily intervals
 * and write the results to a CSV file.  The script can fetch the contract
 * ABI from Etherscan (v2 API) if an API key is provided, and it handles
 * mapping dates to blocks by binary search (so it only needs an archive
 * RPC provider).
 *
 * Usage:  node backfill-price.js [--start-date YYYY-MM-DD] [--start-block N]
 *                             [--end-date YYYY-MM-DD] [--end-block N]
 *                             [--out file.csv]
 *
 * Environment variables (see .env.example):
 *   RPC_URL             compatible Ethereum endpoint
 *   ETHERSCAN_API_KEY   optional, for ABI/block lookups
 *   VAULT_ADDRESS       address of the tranche/vault contract
 *
 * Example:
 *   cp .env.example .env
 *   # fill in values
 *   npm install
 *   node scripts/backfill-price.js --start-date 2024-01-01 --out prices.csv
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// load .env if present
dotenv.config();

const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const RPC_URL = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com/";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

if (!VAULT_ADDRESS) {
  console.error("VAULT_ADDRESS must be set in env");
  process.exit(1);
}
if (!RPC_URL) {
  // fallback default ensures this never triggers, but keep for safety
  console.error("RPC_URL must be set in env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

// helpers for argument parsing
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
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
      case "--out":
        out.outfile = args[++i];
        break;
      default:
        console.warn(`unknown argument ${a}`);
    }
  }
  return out;
}

async function fetchAbi(address) {
  if (!ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY not set; cannot fetch ABI");
  }
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
  const resp = await axios.get(url);
  if (resp.data.status !== "1") {
    throw new Error("failed to fetch ABI: " + resp.data.result);
  }
  return JSON.parse(resp.data.result);
}

function pickPriceFunction(abi) {
  // look for any view function that returns uint256 and has "price" in the name
  const candidates = abi.filter(
    (item) =>
      item.type === "function" &&
      item.stateMutability === "view" &&
      item.outputs &&
      item.outputs.length === 1 &&
      item.outputs[0].type === "uint256" &&
      item.name.toLowerCase().includes("price")
  );
  if (candidates.length === 0) {
    throw new Error("no price-like view function found in ABI");
  }
  // prefer an exact match if present
  for (const fn of candidates) {
    if (fn.name === "price" || fn.name === "tokenPrice" || fn.name === "tranchePrice") {
      return fn.name;
    }
  }
  // otherwise take first candidate
  return candidates[0].name;
}

// find the block closest to (<=) the given UNIX timestamp by binary searching
async function getBlockByTime(targetTs, low = 0, high = null) {
  if (high === null) {
    high = await provider.getBlockNumber();
  }
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const block = await provider.getBlock(mid);
    if (block.timestamp <= targetTs) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

async function main() {
  const opts = parseArgs();
  let startBlock = opts.startBlock;
  let endBlock = opts.endBlock;

  if (opts.startDate) {
    const ts = Math.floor(new Date(opts.startDate).getTime() / 1000);
    startBlock = await getBlockByTime(ts);
  }
  if (opts.endDate) {
    const ts = Math.floor(new Date(opts.endDate).getTime() / 1000);
    endBlock = await getBlockByTime(ts);
  }
  if (!startBlock) {
    startBlock = await provider.getBlockNumber();
  }
  if (!endBlock) {
    endBlock = startBlock;
  }

  let abi;
  try {
    abi = await fetchAbi(VAULT_ADDRESS);
    console.log("fetched ABI from Etherscan");
  } catch (err) {
    console.warn("could not fetch ABI from Etherscan, using minimal fallback");
    // fallback ABI described as JSON objects so pickPriceFunction can inspect
    abi = [
      {
        type: "function",
        name: "price",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
      },
      {
        type: "function",
        name: "tokenPrice",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
      },
      {
        type: "function",
        name: "tranchePrice",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }],
      },
    ];
  }

  const priceFn = pickPriceFunction(abi);
  console.log(`using price function: ${priceFn}`);

  const contract = new ethers.Contract(VAULT_ADDRESS, abi, provider);

  const outfile = opts.outfile || "price-history.csv";
  const stream = fs.createWriteStream(outfile, { flags: "w" });
  stream.write("date,block,price\n");

  for (let block = startBlock; block <= endBlock; ) {
    const blk = await provider.getBlock(block);
    const price = await contract[priceFn]({ blockTag: block });
    const date = new Date(blk.timestamp * 1000).toISOString().slice(0, 10);
    stream.write(`${date},${block},${price.toString()}\n`);
    // advance one day (approx) by timestamp
    const nextTs = blk.timestamp + 24 * 3600;
    const nextBlock = await getBlockByTime(nextTs, block + 1, endBlock);
    if (nextBlock <= block) break;
    block = nextBlock;
  }

  stream.end();
  console.log(`output written to ${outfile}`);
}

// in ESM contexts `require` is not available, and this script is intended
// to be run directly.  Simply invoke main() when the file is executed.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
