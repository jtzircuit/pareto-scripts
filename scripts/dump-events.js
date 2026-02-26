#!/usr/bin/env node
/**
 * dump-events.js
 *
 * Export addresses from contract event logs.
 *
 * Usage:
 *   node scripts/dump-events.js --contract-address 0x... [--start-block N] [--end-block N] [--out file.txt]
 *
 * Fetches ABI from Etherscan (if API key available) to decode events.
 * Otherwise, extracts addresses from raw log topics.
 */

import fs from "fs";
import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";

import { QUERY_CONFIG } from "../lib/config.js";
import { extractAddress, parseArgs } from "../lib/utils.js";

dotenv.config();

const ENV_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || process.env.VAULT_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

if (!RPC_URL) {
  console.error("RPC_URL must be set in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);

/**
 * Fetch contract ABI from Etherscan
 * @private
 */
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

/**
 * Main entry point: extract addresses from contract events
 */
async function main() {
  const schemaMap = {
    startBlock: "number",
    endBlock: "number",
    outfile: "string",
    contractAddress: "string",
  };
  const opts = parseArgs(process.argv.slice(2), schemaMap);
  const contractAddress = opts.contractAddress || ENV_CONTRACT_ADDRESS;
  if (!contractAddress) {
    console.error("set CONTRACT_ADDRESS/VAULT_ADDRESS in env or pass --contract-address");
    process.exit(1);
  }

  const startBlock = opts.startBlock || 0;
  const endBlock = opts.endBlock || (await provider.getBlockNumber());

  let abi;
  try {
    abi = await fetchAbi(contractAddress);
  } catch (err) {
    console.warn("could not fetch ABI, events will not be decoded");
    abi = [];
  }

  const iface = new ethers.Interface(abi);
  const uniqueAddresses = new Set();

  // Query logs in chunks to avoid RPC timeouts
  for (let from = startBlock; from <= endBlock; from += QUERY_CONFIG.LOG_CHUNK_SIZE) {
    const to = Math.min(from + QUERY_CONFIG.LOG_CHUNK_SIZE - 1, endBlock);
    console.log(`querying logs ${from}-${to}...`);

    const logs = await provider.getLogs({
      address: contractAddress,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      if (abi.length) {
        try {
          const parsed = iface.parseLog(log);
          // Extract addresses from decoded log arguments
          for (const key of Object.keys(parsed.args)) {
            const val = parsed.args[key];
            if (ethers.isAddress(val)) {
              uniqueAddresses.add(ethers.getAddress(val));
            }
          }
        } catch {
          // Skip unparseable events
        }
      } else {
        // If no ABI, extract address-like values from log topics
        for (const topic of log.topics.slice(1)) {
          if (topic.length === 66) {
            const addr = `0x${topic.slice(26)}`;
            if (ethers.isAddress(addr)) {
              uniqueAddresses.add(ethers.getAddress(addr));
            }
          }
        }
      }
    }
  }

  const outfile = opts.outfile || "addresses.txt";
  fs.writeFileSync(outfile, Array.from(uniqueAddresses).sort().join("\n"));
  console.log(`wrote ${uniqueAddresses.size} unique addresses to ${outfile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
