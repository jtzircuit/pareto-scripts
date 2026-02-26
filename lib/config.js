/**
 * Configuration constants and network definitions for vault price backfill
 */

// RPC and retry configuration
export const RPC_CONFIG = {
  MAX_RETRIES_PER_PROVIDER: 2,
  RETRY_DELAY_MS: 500,
};

// Network configurations with RPC endpoints and explorer URLs
export const NETWORKS = {
  ethereum: {
    chainId: 1,
    sourcifyChainId: 1,
    explorer: "https://etherscan.io/",
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com/",
      "https://eth.drpc.org",
      "https://eth1.lava.build",
    ],
  },
  base: {
    chainId: 8453,
    sourcifyChainId: 8453,
    explorer: "https://basescan.org/",
    rpcUrls: [
      "https://base-rpc.publicnode.com",
      "https://base.lava.build",
      "https://base.drpc.org",
    ],
  },
};

// Price function detection and preference order
export const PRICE_FUNCTIONS = {
  standard: ["priceAA", "priceBB", "price", "tokenPrice", "tranchePrice", "pricePerShare", "getPricePerFullShare"],
  AA: ["priceAA", "priceBB", "price", "tokenPrice", "tranchePrice", "pricePerShare", "getPricePerFullShare"],
  BB: ["priceBB", "priceAA", "price", "tokenPrice", "tranchePrice", "pricePerShare", "getPricePerFullShare"],
};

// Error detection patterns for RPC retry logic
export const RETRIABLE_ERROR_PATTERNS = [
  "503",
  "500",
  "timeout",
  "temporar",
  "overflow",
  "cannot fulfill request",
  "server response",
  "free tier",
  "rate limit",
  "request limit",
  "too many requests",
  "historical state",
  "not available",
];

// Query configuration for event dumping
export const QUERY_CONFIG = {
  LOG_CHUNK_SIZE: 50000, // blocks per query to avoid timeouts
  SOURCIFY_TIMEOUT_MS: 10000,
};

// Chain key normalization mappings
export const CHAIN_ALIASES = {
  mainnet: "ethereum",
  eth: "ethereum",
  "base-mainnet": "base",
};
