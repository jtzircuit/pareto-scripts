#!/usr/bin/env node
/*
 * dump-events.js
 *
 * Export a list of all unique Ethereum addresses mentioned in the logs of
 * the vault/tranche contract.  Useful for identifying participants or
 * discovering which wallets interact with the vault.
 *
 * Usage:
 *   node scripts/dump-events.js [--start-block N] [--end-block N] [--out file.txt]
 *
 * The script will fetch the ABI from Etherscan (if an API key is provided)
 * so it can decode events.  Logs are queried directly from the RPC provider.
 */

import fs from "fs";
import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

if (!VAULT_ADDRESS || !RPC_URL) {
  console.error("VAULT_ADDRESS and RPC_URL must be set in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
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

async function main() {
  const opts = parseArgs();
  let startBlock = opts.startBlock || 0;
  let endBlock = opts.endBlock;
  if (!endBlock) endBlock = await provider.getBlockNumber();

  let abi;
  try {
    abi = await fetchAbi(VAULT_ADDRESS);
  } catch (err) {
    console.warn("could not fetch ABI, events will not be decoded");
    abi = [];
  }
  const iface = new ethers.Interface(abi);

  const unique = new Set();

  const step = 50000; // query in chunks to avoid timeouts
  for (let from = startBlock; from <= endBlock; from += step) {
    const to = Math.min(from + step - 1, endBlock);
    console.log(`querying logs ${from}-${to}`);
    const logs = await provider.getLogs({
      address: VAULT_ADDRESS,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      if (abi.length) {
        try {
          const parsed = iface.parseLog(log);
          // look for any address-sized topic or argument
          for (const key of Object.keys(parsed.args)) {
            const val = parsed.args[key];
            if (ethers.isAddress(val)) unique.add(val);
          }
        } catch (e) {
          // ignore unparsed events
        }
      } else {
        // If we have no ABI, at least include topics that look like addresses
        for (const topic of log.topics.slice(1)) {
          if (topic.length === 66) {
            const addr = `0x${topic.slice(26)}`;
            unique.add(addr.toLowerCase());
          }
        }
      }
    }
  }

  const outfile = opts.outfile || "addresses.txt";
  fs.writeFileSync(outfile, Array.from(unique).join("\n"));
  console.log(`wrote ${unique.size} addresses to ${outfile}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
