# Polyester DEX Market Maker & Trading Bot

A high-performance Two-Sided Limit Market Maker and Trading Bot for **Polyester DEX Testnet** built with Node.js.

Features a real-time Terminal UI (TUI), automated inventory balancing, post-only quoting, and native multi-wallet support.

---

## Key Features

- **Two-Sided Limit Market Maker**: Places resting Post-Only Bid and Ask quotes around the live L2 orderbook mid-price to earn the spread without paying taker fees.
- **Dynamic Inventory Balancing**: Automatically bootstraps initial base tokens when needed and trims excess inventory to keep balances balanced.
- **Queue Priority Preservation**: Holds active resting orders when price drift is below tolerance, minimizing unnecessary order churn.
- **Multi-Wallet Support**: Quote and manage multiple independent main wallets simultaneously from a single process using `wallets.json`.
- **Live Terminal UI Dashboard**: Real-time stats showing active quotes, spreads, fills, session volume, and portfolio equity.
- **Dead-Man Switch**: Automatically refreshes the exchange-level safety heartbeat to cancel resting orders if the bot disconnects.

---

## Quick Start

### 1. Prerequisites
- **Node.js 22+** installed.
- An Ed25519 API Key from your [Polyester Account Settings](https://testnet.polyester.com/account/api-keys) with Trading and Balances permissions enabled.

### 2. Installation
```bash
git clone https://github.com/datphuocnguyen04/polyester-market-maker.git
cd polyester-market-maker
npm install
```

### 3. Configuration

#### Single Wallet Setup:
Copy the example environment file:
```bash
cp .env.example .env
```
Open `.env` and provide your credentials:
```env
POLYESTER_API_KEY_ID=ak_...
POLYESTER_API_PRIVATE_KEY=your_64_char_hex_key
OWNER_PRIVATE_KEY=0x...
```

#### Multi-Wallet Setup (Optional):
To run multiple wallets concurrently, create a `wallets.json` file in the root directory:
```bash
cp wallets.example.json wallets.json
```
Define your accounts:
```json
[
  {
    "name": "Wallet-1",
    "apiKeyId": "ak_...",
    "apiPrivateKey": "...",
    "ownerPrivateKey": "0x..."
  },
  {
    "name": "Wallet-2",
    "apiKeyId": "ak_...",
    "apiPrivateKey": "...",
    "ownerPrivateKey": "0x..."
  }
]
```

---

## Usage

```bash
# Start continuous Two-Sided Market Maker with live Terminal UI
npm start

# Run in Dry-Run mode (computes quotes without placing real orders)
npm run dry

# Run a single quote cycle and exit
npm run once

# Run one-off round-trip taker swaps
npm run swap

# Run test suite and typechecks
npm test
npm run typecheck
```

---

## Strategy Settings

All key market-making parameters can be tuned in `.env`:

| Variable | Default | Description |
|---|---|---|
| `SWAP_AMOUNT_USDT` | `600` | Target quote notional per order side (auto-scaled to account equity) |
| `TRENDING_COUNT` | `6` | Number of top pairs by 24h volume to market make |
| `MM_HALF_SPREAD_BPS` | `4` | Half-spread from mid-price in basis points (4 bps = 0.04%) |
| `MM_REQUOTE_DRIFT_BPS` | `4` | Mid-price drift threshold before replacing resting quotes |
| `MM_REFRESH_INTERVAL_MS` | `4000` | Loop refresh interval in milliseconds |
| `MM_BOOTSTRAP_INVENTORY` | `true` | Automatically balance base inventory for quoting |
| `MM_TURBO_TURNOVER` | `false` | Enable aggressive market-order volume boosting |


