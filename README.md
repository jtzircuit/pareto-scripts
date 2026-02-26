# Vault Share Price Backfill

Utilities to backfill on-chain share-price history into CSV from any vault URL or contract address.

## Setup

```bash
npm install
cp .env.example .env
```

No private keys are required.

Set `RPC_URL` or `RPC_URLS` in `.env` only if you want to override defaults.  
Built-in public RPC pools:

- Ethereum:
  - `https://ethereum-rpc.publicnode.com/`
  - `https://eth.drpc.org`
  - `https://eth1.lava.build`
- Base:
  - `https://base-rpc.publicnode.com`
  - `https://base.lava.build`
  - `https://base.drpc.org`

## LLM-Friendly Quick Start

If you have any link containing a vault address (or a raw `0x...` address):

run:

```bash
node scripts/backfill-price.js \
  --vault 'https://some-app.example/vault/0x...' \
  --chain ethereum \
  --block-step 7200 \
  --out vault.csv
```

The script will auto-discover:
- whether the input is a token or price source contract
- token `minter()` when present
- share-price function (`priceAA`, `priceBB`, `price`, `tokenPrice`, etc.)
- deployment block for default backfill range

Default range is `deployment -> latest`.

## CSV Output

```csv
date,block,price
```

Footer summary is appended at the end of the file:

```text
# Summary
# Days: ...
# Average APR: ...
# Method: ...
# Network: ...
```

## Recommended Commands

Fast sampled backfill (recommended):

```bash
node scripts/backfill-price.js \
  --vault 'https://some-app.example/vault/0x...' \
  --block-step 7200 \
  --out vault-fast.csv
```

Exact daily backfill (slower):

```bash
node scripts/backfill-price.js \
  --vault 'https://some-app.example/vault/0x...' \
  --out vault-daily.csv
```

Discovery only (no file output):

```bash
node scripts/backfill-price.js \
  --vault 'https://some-app.example/vault/0x...' \
  --discover-only
```

## Backfill Arguments

- `--vault <url_or_address>` preferred input
- `--chain <ethereum|base>` optional override (otherwise inferred from URL when possible)
- `--contract-address <address>` alternate explicit input
- `--price-fn <name>` force specific function
- `--start-date YYYY-MM-DD`
- `--end-date YYYY-MM-DD`
- `--start-block <number>`
- `--end-block <number>`
- `--block-step <number>` fast sampling mode
- `--out <file.csv>` (default `price-history.csv`)
- `--discover-only`
- `--rpc-urls <url1,url2,...>` override RPC pool order

Notes:
- Date parsing uses UTC midnight (`YYYY-MM-DDT00:00:00Z`).
- If `--start-block` is earlier than source deployment, it is clamped to deploy block.
- Script distributes RPC calls across the configured pool and retries/fails over on transient timeout/rate-limit/server errors.
- `method` and `network` are included in the footer summary (not per-row columns).
- For Base links, chain is inferred from `/base/` in the URL; you can also pass `--chain base`.
- Base explorer: `https://basescan.org/`

## Dump Participant Addresses

```bash
node scripts/dump-events.js \
  --contract-address 0xYourVaultOrTokenAddress \
  --start-block 1 \
  --out participants.txt
```

This scans logs for `--contract-address` (or env `CONTRACT_ADDRESS`/`VAULT_ADDRESS`) and extracts unique addresses.
