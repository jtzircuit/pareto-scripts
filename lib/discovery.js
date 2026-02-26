/**
 * Contract discovery and ABI fetching utilities
 */

import axios from "axios";
import { ethers } from "ethers";
import { tryCall, isValidAddress } from "./utils.js";
import { PRICE_FUNCTIONS, QUERY_CONFIG } from "./config.js";
import { rpcCall } from "./provider.js";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;

/**
 * Resolve minter address from a token contract
 * @param {string} tokenAddress - Token contract address
 * @param {string|number} blockTag - Block identifier
 * @returns {Promise<string|null>} Minter address or null
 */
export async function resolveMinter(tokenAddress, blockTag = "latest") {
  const res = await tryCall(
    tokenAddress,
    "function minter() view returns (address)",
    "minter",
    [],
    blockTag
  );
  if (!res.ok) return null;
  if (!isValidAddress(res.value)) return null;

  const checksum = ethers.getAddress(res.value);
  const code = await rpcCall((p) => p.getCode(checksum, blockTag));
  return code && code !== "0x" ? checksum : null;
}

/**
 * Resolve token symbol from a token contract
 * @param {string} tokenAddress - Token contract address
 * @param {string|number} blockTag - Block identifier
 * @returns {Promise<string|null>} Token symbol or null
 */
export async function resolveTokenSymbol(tokenAddress, blockTag = "latest") {
  const res = await tryCall(
    tokenAddress,
    "function symbol() view returns (string)",
    "symbol",
    [],
    blockTag
  );
  if (!res.ok || typeof res.value !== "string") return null;
  return res.value;
}

/**
 * Get preferred price functions based on token symbol
 * @param {string|null} symbol - Token symbol
 * @returns {string[]} Ordered list of function names to try
 */
export function preferredFunctionsFromSymbol(symbol) {
  if (!symbol) return PRICE_FUNCTIONS.standard;
  const s = symbol.toUpperCase();
  if (s.includes("AA")) return PRICE_FUNCTIONS.AA;
  if (s.includes("BB")) return PRICE_FUNCTIONS.BB;
  return PRICE_FUNCTIONS.standard;
}

/**
 * Discover price source (contract and function) from input address
 * @param {string} inputAddress - Input contract or token address
 * @param {Object} opts - Options with optional priceFn override
 * @returns {Promise<Object>} Discovery result with sourceAddress, sourceFunction, mode, etc.
 * @throws {Error} If price source cannot be discovered
 */
export async function discoverPriceSource(inputAddress, opts) {
  const latest = await rpcCall((p) => p.getBlockNumber());
  const tokenSymbol = await resolveTokenSymbol(inputAddress, latest);
  const minter = await resolveMinter(inputAddress, latest);

  const candidates = [];
  if (minter) candidates.push({ address: minter, hint: "minter" });
  candidates.push({ address: inputAddress, hint: "input" });

  const functionOrder = opts.priceFn ? [opts.priceFn] : preferredFunctionsFromSymbol(tokenSymbol);

  // Try direct price functions
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

  // Try ERC4626 convertToAssets
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

/**
 * Fetch ABI from Etherscan
 * @param {string} address - Contract address
 * @param {number} chainId - Chain ID
 * @returns {Promise<any[]>} Contract ABI
 * @throws {Error} If ETHERSCAN_API_KEY not set or lookup fails
 */
export async function fetchAbiFromEtherscan(address, chainId) {
  if (!ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY not set");
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
  const resp = await axios.get(url);
  if (resp.data.status !== "1") throw new Error(resp.data.result || "etherscan abi lookup failed");
  return JSON.parse(resp.data.result);
}

/**
 * Fetch ABI from Sourcify (decentralized ABI repository)
 * @param {string} address - Contract address
 * @param {number} sourcifyChainId - Sourcify chain ID
 * @returns {Promise<any[]>} Contract ABI
 * @throws {Error} If lookup fails on all endpoints
 */
export async function fetchAbiFromSourcify(address, sourcifyChainId) {
  const endpoints = [
    `https://repo.sourcify.dev/contracts/full_match/${sourcifyChainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${sourcifyChainId}/${address}/metadata.json`,
  ];
  for (const url of endpoints) {
    try {
      const resp = await axios.get(url, { timeout: QUERY_CONFIG.SOURCIFY_TIMEOUT_MS });
      if (resp.data?.output?.abi) return resp.data.output.abi;
    } catch {
      // continue to next endpoint
    }
  }
  throw new Error("sourcify abi lookup failed");
}

/**
 * Get ABI for address with fallback sources
 * @param {string} address - Contract address
 * @param {Object} chainCfg - Chain configuration object
 * @returns {Promise<any[]>} Contract ABI or empty array
 */
export async function getAbiForAddress(address, chainCfg) {
  try {
    const abi = await fetchAbiFromEtherscan(address, chainCfg.chainId);
    console.log("fetched ABI from Etherscan");
    return abi;
  } catch {
    // fallback
  }
  try {
    const abi = await fetchAbiFromSourcify(address, chainCfg.sourcifyChainId);
    console.log("fetched ABI from Sourcify");
    return abi;
  } catch {
    // fallback
  }
  return [];
}
