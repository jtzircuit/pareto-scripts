# MEMORY

This file stores practical, session-independent notes for future LLM agents working in this repo.

## Purpose

- Preserve learned behavior about vault discovery/backfill.
- Record known-good commands, pitfalls, and investigation paths.
- Avoid repeating dead ends.

## Repo Reality

- Main script: `scripts/backfill-price.js`
- Helper modules: `lib/config.js`, `lib/provider.js`, `lib/discovery.js`, `lib/utils.js`
- Event utility: `scripts/dump-events.js`

CSV format currently:
- rows: `date,block,price`
- footer:
  - `# Days: ...`
  - `# Average APR: ...`
  - `# Method: ...`
  - `# Network: ...`
  - `# Explorer: ...`

## Supported Networks / Public RPC Pools

Ethereum:
- `https://ethereum-rpc.publicnode.com/`
- `https://eth.drpc.org`
- `https://eth1.lava.build`

Base:
- `https://base-rpc.publicnode.com`
- `https://base.lava.build`
- `https://base.drpc.org`

Behavior:
- Script round-robins and fails over across pool.
- Some providers are non-archive for deep history; failover is required.

## Known Good Vault Tests

### Pareto RockawayX (Ethereum)

Input URL:
- `https://app.pareto.credit/vault#0xEC6a70F62a83418c7fb238182eD2865F80491a8B`

Learned mapping:
- Token: `0xEC6a70F62a83418c7fb238182eD2865F80491a8B`
- Minter/price source: `0x9cF358aff79DeA96070A85F00c0AC79569970Ec3`
- Method: `priceAA`

### Pareto FalconX (Ethereum)

Input URL:
- `https://app.pareto.credit/vault#0xC26A6Fa2C37b38E549a4a1807543801Db684f99C`

Learned mapping:
- Token: `0xC26A6Fa2C37b38E549a4a1807543801Db684f99C`
- Minter/price source: `0x433D5B175148dA32Ffe1e1A37a939E1b7e79be4d`
- Method: `priceAA`

### Morpho steakUSDC (Ethereum)

Input URL:
- `https://app.morpho.org/ethereum/vault/00xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB/steakhouse-usdc`

Learned mapping:
- Source address: `0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB`
- Method: `convertToAssets` (ERC4626 mode)

### Morpho gtUSDCp (Base)

Input URL:
- `https://app.morpho.org/base/vault/0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61/gauntlet-usdc-prime`

Learned mapping:
- Source address: `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`
- Method: `convertToAssets` (ERC4626 mode)
- Network: `base:8453`
- Explorer: `https://basescan.org/`

## Hard Case: Gauntlet `gpaafalconx`

Input URL:
- `https://app.gauntlet.xyz/vaults/gpaafalconx`

Observed:
- URL path contains slug (`aera:gpaafalconx`) not direct `0x...`.
- Embedded addresses seen on site:
  - Vault token: `0x00000000d8f3d6c5DFeB2D2b5ED2276095f3aF44` (`gpAAFalconX`)
  - Provisioner: `0x21994912f1D286995c4d4961303cBB8E44939944`
- Standard discovery currently fails for both (no direct `price*/convertToAssets` getter).

Provisioner selector mapping discovered:
- `requestDeposit`, `requestRedeem`, `solveRequestsDirect`, `solveRequestsVault`
- `PRICE_FEE_CALCULATOR()`
- `tokensDetails(address)`
- `depositCap`, `maxDeposit`, `depositRefundTimeout`

Inference:
- Pricing appears solver/provisioner-driven (request/solve lifecycle), not exposed via a simple public share-price view on token/provisioner.

Next path for this class:
1. Resolve/verify ABI for Provisioner and `PRICE_FEE_CALCULATOR`.
2. Decode solve events to reconstruct effective price per unit over time.
3. Add adapter mode for async-request products (not just direct view-function products).

## Investigation Playbook (Use In Order)

1. Run discovery:
   - `node scripts/backfill-price.js --vault '<url_or_address>' --discoverOnly`
2. If discovery fails:
   - Extract all addresses from page HTML.
   - Probe candidate address methods (`name`, `symbol`, `minter`, `convertToAssets`, `price*`).
   - If token has `minter()`, inspect minter for `priceAA/priceBB`.
3. If still no price getter:
   - Extract selectors from bytecode and map to known signatures.
   - Inspect request/solve events for implicit pricing.
4. For non-archive RPC errors:
   - Retry with full RPC pool and smaller block windows.

## Useful Commands

Fast backfill:
```bash
node scripts/backfill-price.js --vault '<url_or_address>' --block-step 7200 --out out.csv
```

Discovery only:
```bash
node scripts/backfill-price.js --vault '<url_or_address>' --discoverOnly
```

Force chain:
```bash
node scripts/backfill-price.js --vault '<url_or_address>' --chain base --block-step 7200 --out out.csv
```

## Safety / Infra Notes

- Public infrastructure only; no private keys needed.
- Keep `.env` free of secrets unless strictly necessary.
- Prefer RPC pools over single endpoints to reduce timeout/rate-limit failures.
