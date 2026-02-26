/**
 * Provider pool management for RPC failover and load balancing
 */

import { ethers } from "ethers";
import { isRetriableRpcError, sleep } from "./utils.js";
import { RPC_CONFIG } from "./config.js";

let providerPool = [];
let providerCursor = 0;

/**
 * Initialize the RPC provider pool
 * @param {string[]} rpcUrls - Array of RPC URLs
 */
export function initializeProviderPool(rpcUrls) {
  if (!rpcUrls || !rpcUrls.length) {
    throw new Error("no RPC URLs configured");
  }
  providerPool = rpcUrls.map((url) => ({
    url,
    provider: new ethers.JsonRpcProvider(url),
  }));
  providerCursor = 0;
}

/**
 * Get current provider pool state for logging
 * @returns {Object} Pool info
 */
export function getProviderPoolInfo() {
  return {
    count: providerPool.length,
    urls: providerPool.map((p) => p.url),
    currentIndex: providerCursor,
  };
}

/**
 * Execute an RPC call with automatic failover and retry logic
 * @param {Function} task - Async function that takes (provider, url) and returns result
 * @param {number} retriesPerProvider - Retries per provider (optional)
 * @returns {Promise<any>} Result from successful call
 * @throws {Error} If all providers fail
 */
export async function rpcCall(task, retriesPerProvider = RPC_CONFIG.MAX_RETRIES_PER_PROVIDER) {
  if (!providerPool.length) {
    throw new Error("provider pool not initialized");
  }

  let lastErr;
  const n = providerPool.length;
  const order = [];
  for (let i = 0; i < n; i++) {
    order.push((providerCursor + i) % n);
  }

  for (const idx of order) {
    const item = providerPool[idx];
    for (let attempt = 0; attempt < retriesPerProvider; attempt++) {
      try {
        const result = await task(item.provider, item.url);
        providerCursor = (idx + 1) % n;
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetriableRpcError(err)) throw err;
        if (attempt < retriesPerProvider - 1) {
          await sleep(RPC_CONFIG.RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }
  }

  throw lastErr || new Error("rpc call failed on all providers");
}

/**
 * Find block number at or before target timestamp using binary search
 * @param {number} targetTs - Target Unix timestamp (seconds)
 * @param {number} low - Low block boundary
 * @param {number|null} high - High block boundary (fetched if null)
 * @returns {Promise<number>} Block number
 */
export async function getBlockByTime(targetTs, low = 0, high = null) {
  if (high === null) {
    high = await rpcCall((p) => p.getBlockNumber());
  }
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const block = await rpcCall((p) => p.getBlock(mid));
    if (Number(block.timestamp) <= targetTs) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Find deployment block of a contract using binary search
 * @param {string} address - Contract address
 * @returns {Promise<number>} Deployment block number
 */
export async function getDeployBlock(address) {
  const latest = await rpcCall((p) => p.getBlockNumber());
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await rpcCall((p) => p.getCode(address, mid));
    if (code && code !== "0x") high = mid;
    else low = mid + 1;
  }
  return low;
}
