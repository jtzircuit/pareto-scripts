/**
 * Shared utility functions for vault price and event monitoring
 */

import { ethers } from "ethers";
import { RETRIABLE_ERROR_PATTERNS, CHAIN_ALIASES } from "./config.js";

/**
 * Parse command-line arguments into an options object
 * @param {string[]} args - Command-line arguments
 * @param {Object} schema - Schema defining expected arguments: { argName: 'type' }
 *   Types: 'string', 'number', 'boolean'
 * @returns {Object} Parsed options object
 */
export function parseArgs(args, schema) {
  const out = {};
  const schemaLower = Object.fromEntries(
    Object.entries(schema || {}).map(([key, type]) => [key.toLowerCase(), { key, type }])
  );

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2).toLowerCase();
    const schemaEntry = schemaLower[key];
    if (!schemaEntry) {
      console.warn(`unknown argument ${arg}`);
      continue;
    }

    const { key: originalKey, type } = schemaEntry;
    const value = args[++i];

    if (type === "boolean") {
      out[originalKey] = true;
      i--; // backtrack since no value consumed
    } else if (type === "number") {
      out[originalKey] = parseInt(value, 10);
    } else {
      out[originalKey] = value;
    }
  }
  return out;
}

/**
 * Convert ISO date string to Unix timestamp (seconds)
 * @param {string} dateStr - Date in ISO format (YYYY-MM-DD)
 * @returns {number} Unix timestamp in seconds
 * @throws {Error} If date format is invalid
 */
export function parseDateToUnixSeconds(dateStr) {
  const ts = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
  if (!Number.isFinite(ts)) throw new Error(`invalid date: ${dateStr}`);
  return ts;
}

/**
 * Extract Ethereum address from input string
 * @param {string|null} input - String potentially containing an address
 * @returns {string|null} Checksummed Ethereum address or null
 */
export function extractAddress(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (ethers.isAddress(trimmed)) return ethers.getAddress(trimmed);
  const m = trimmed.match(/0x[a-fA-F0-9]{40}/);
  if (m && ethers.isAddress(m[0])) return ethers.getAddress(m[0]);
  return null;
}

/**
 * Normalize chain key with alias resolution
 * @param {string|null} raw - Raw chain key from input
 * @returns {string|null} Normalized chain key
 */
export function normalizeChainKey(raw) {
  if (!raw) return null;
  const k = raw.toLowerCase().trim();
  return CHAIN_ALIASES[k] || (Object.keys(CHAIN_ALIASES).includes(k) ? CHAIN_ALIASES[k] : k);
}

/**
 * Infer chain key from URL or other string patterns
 * @param {string|null} input - Input string (URL or address)
 * @returns {string|null} Inferred chain key or null
 */
export function inferChainKey(input) {
  const s = String(input || "").toLowerCase();
  if (s.includes("/base/") || s.includes("basescan.org")) return "base";
  if (s.includes("/ethereum/") || s.includes("etherscan.io")) return "ethereum";
  return null;
}

/**
 * Check if RPC error is retriable (temporary)
 * @param {Error} err - Error object from RPC call
 * @returns {boolean} True if error is retriable
 */
export function isRetriableRpcError(err) {
  const msg = `${err?.shortMessage || ""} ${err?.message || ""} ${err?.info?.error?.message || ""}`.toLowerCase();
  return RETRIABLE_ERROR_PATTERNS.some((pattern) => msg.includes(pattern));
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt a contract call with try/catch, using rpcCall internally
 * @param {string} address - Contract address
 * @param {string} abiSig - Function ABI signature
 * @param {string} fnName - Function name
 * @param {any[]} args - Function arguments
 * @param {string|number} blockTag - Block identifier
 * @returns {Promise<{ok: boolean, value?: any}>} Result object
 */
export async function tryCall(address, abiSig, fnName, args = [], blockTag = "latest") {
  try {
    const value = await (await import("./provider.js")).rpcCall(async (provider) => {
      const c = new ethers.Contract(address, [abiSig], provider);
      return c[fnName](...args, { blockTag });
    });
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Validate Ethereum address format
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid address
 */
export function isValidAddress(address) {
  return ethers.isAddress(address);
}

/**
 * Format large numbers for display
 * @param {number|bigint} value - Value to format
 * @param {number} decimals - Number of decimals to show
 * @returns {string} Formatted string
 */
export function formatNumber(value, decimals = 2) {
  if (typeof value === "bigint") value = Number(value);
  return Number(value).toFixed(decimals);
}
