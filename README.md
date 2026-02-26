# Pareto Vault Monitoring

Utilities to backfill on-chain share-price history into CSV from a vault URL or contract address.

## Setup

```bash
npm install
cp .env.example .env
```

Set `RPC_URL` in `.env`. For reliable runs, use an archive-capable endpoint.  
Useful fallback: `https://eth.drpc.org`.

## LLM-Friendly Quick Start

If you have a link like:

`https://app.pareto.credit/vault#0x...`

run:

```bash
RPC_URL=https://eth.drpc.org node scripts/backfill-price.js \
  --vault 'https://app.pareto.credit/vault#0x...' \
  --block-step 7200 \
  --out vault.csv
```

The script will auto-discover:
- whether the input is a token or price source contract
- Pareto token `minter()` when present
- share-price function (`priceAA`, `priceBB`, `price`, `tokenPrice`, etc.)
- deployment block for default backfill range

Default range is `deployment -> latest`.

## CSV Output

```csv
date,block,price
```

## Recommended Commands

Fast sampled backfill (recommended):

```bash
RPC_URL=https://eth.drpc.org node scripts/backfill-price.js \
  --vault 'https://app.pareto.credit/vault#0xEC6a70F62a83418c7fb238182eD2865F80491a8B' \
  --block-step 7200 \
  --out rockawayx.csv
```

Exact daily backfill (slower):

```bash
RPC_URL=https://eth.drpc.org node scripts/backfill-price.js \
  --vault 'https://app.pareto.credit/vault#0xEC6a70F62a83418c7fb238182eD2865F80491a8B' \
  --out rockawayx-daily.csv
```

Discovery only (no file output):

```bash
RPC_URL=https://eth.drpc.org node scripts/backfill-price.js \
  --vault 'https://app.pareto.credit/vault#0x...' \
  --discover-only
```

## Backfill Arguments

- `--vault <url_or_address>` preferred input
- `--contract-address <address>` alternate explicit input
- `--price-fn <name>` force specific function
- `--start-date YYYY-MM-DD`
- `--end-date YYYY-MM-DD`
- `--start-block <number>`
- `--end-block <number>`
- `--block-step <number>` fast sampling mode
- `--out <file.csv>` (default `price-history.csv`)
- `--discover-only`

Notes:
- Date parsing uses UTC midnight (`YYYY-MM-DDT00:00:00Z`).
- If `--start-block` is earlier than source deployment, it is clamped to deploy block.
- Some RPC providers are not archive-capable and cannot serve historical state.

## Dump Participant Addresses

```bash
node scripts/dump-events.js \
  --contract-address 0xEC6a70F62a83418c7fb238182eD2865F80491a8B \
  --start-block 24000000 \
  --out participants.txt
```

This scans logs for `--contract-address` (or env `CONTRACT_ADDRESS`/`VAULT_ADDRESS`) and extracts unique addresses.
