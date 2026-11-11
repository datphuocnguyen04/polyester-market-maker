# Polyester DEX Testnet Auto-Swap & 13h Daily Reward Claim Bot

An automated market-making / volume & reward-claiming tool for **Polyester DEX Testnet** (`api.testnet.polyester.com`) built with TypeScript, Node.js, and `@polyester/sdk`.

Every **13 hours**, the bot runs a cycle that:
1. **Claims the Daily Testnet Reward**: Authenticates via wallet SIWE challenge (`POST /v1/auth/wallet-challenge` -> raw EIP-191 signature -> `POST /v1/auth/login/wallet`), checks `client.claims.getDailyClaimStatus()`, and claims the reward (`claimDailyReward()`) if available.
   - *Note*: Polyester's daily reward policy is `UTC_DAILY` (resets at `00:00 UTC`). Running every 13 hours guarantees at least one check in every UTC day while safely skipping cycles where today's reward has already been claimed.
2. **Selects Top 5 Trending Pairs**: Queries `client.marketOverview.list({ orderBy: "volume_24h_usd", sort: "desc" })` and the Spot Catalog (`client.catalog`), filtering for active (`enabled`), `USDT`-quoted pairs that support buy fees in the base asset and meet minimum notional rules.
3. **Executes Round-Trip Swaps (`USDT -> Base -> USDT`)**: Uses ConnectRPC `swap.v1.SwapService` (`QuoteSwap`, `CreateSwap`, `GetSwap`) signed with your Ed25519 API key to swap `SWAP_AMOUNT_USDT` into each trending base asset and immediately swap the received base asset back to `USDT` so your inventory stays flat.

---

## Prerequisites & One-Time Setup

1. **Node.js 22+** installed.
2. **One-time X or Discord verification**: In the [Polyester Testnet web app](https://testnet.polyester.com), click the gift icon in the top navigation bar once and link your X or Discord account. Without this, daily claims return `SOCIAL_VERIFICATION_REQUIRED`.
3. **Create an Ed25519 API Key**:
   - Open [https://testnet.polyester.com/account/api-keys](https://testnet.polyester.com/account/api-keys).
   - Generate a new key in browser for your Main Account (or target Subaccount).
   - Enable **Swap** (and **Balances** / **Spot Trading**) permissions.
   - Copy the `ak_...` Key ID and 64-character hex private key.
4. **Configure `.env`**:
   ```powershell
   Copy-Item .env.example .env
   ```
   Fill in `POLYESTER_API_KEY_ID`, `POLYESTER_API_PRIVATE_KEY`, and `OWNER_PRIVATE_KEY` (the `0x...` private key of the EOA wallet that owns your Polyester account).

---

## Commands

```powershell
# Install dependencies
npm install

# Run a dry-run cycle (checks claim status & quotes top 5 swaps without executing)
npm run dry

# Run a single live cycle (claims daily reward if available + round-trip swaps 5 trending pairs)
npm run once

# Start the continuous 13-hour loop (persists schedule across restarts in state.json)
npm start

# Run only the daily claim or only the swaps
npm run claim
npm run swap

# Typecheck & unit tests
npm run typecheck
npm test
```
