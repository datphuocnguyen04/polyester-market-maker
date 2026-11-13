import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";

export interface WalletCredentials {
  name: string;
  apiKeyId: string;
  apiPrivateKey: string;
  ownerPrivateKey: Hex;
  smartAccountAddress?: Hex;
  subaccountId?: string;
}

export interface BotConfig extends WalletCredentials {
  apiKeyRecvWindowMs?: number;
  swapAmountUsdt: string;
  maxSlippageBps: number;
  trendingCount: number;
  quoteAsset: string;
  intervalHours: number;
  pairDelayMs: number;
  mmHalfSpreadBps: number;
  mmRequoteDriftBps: number;
  mmRefreshIntervalMs: number;
  mmBootstrapInventory: boolean;
  mmTurboTurnover: boolean;
  apiUrl: string;
  dryRun: boolean;
  /** Open the Polyester web app in the default browser (once per UTC day) when manual claim is needed. */
  claimOpenBrowser: boolean;
  /** Hours between automated wallet-login re-probes while login is blocked (HTTP 403). */
  claimReprobeHours: number;
}

const PLACEHOLDER_HEX_64 = "0".repeat(64);

export function loadConfig(overrides?: {
  dryRun?: boolean;
  requireSwapAuth?: boolean;
  requireClaimAuth?: boolean;
}): BotConfig {
  const dryRun =
    overrides?.dryRun ??
    (process.env.DRY_RUN?.toLowerCase() === "true" || process.env.DRY_RUN === "1");

  const requireSwapAuth = overrides?.requireSwapAuth ?? true;
  const requireClaimAuth = overrides?.requireClaimAuth ?? true;

  const apiKeyId = (process.env.POLYESTER_API_KEY_ID ?? "").trim();
  const rawApiPriv = (process.env.POLYESTER_API_PRIVATE_KEY ?? "").trim().replace(/^0x/i, "");

  if (requireSwapAuth) {
    if (!apiKeyId || apiKeyId === "ak_...") {
      throw new Error(
        "Missing or placeholder POLYESTER_API_KEY_ID in .env (expected key starting with 'ak_')"
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(rawApiPriv) || rawApiPriv === PLACEHOLDER_HEX_64) {
      throw new Error(
        "Missing or invalid POLYESTER_API_PRIVATE_KEY in .env (expected 64 hex characters)"
      );
    }
  }

  const rawOwnerPriv = (process.env.OWNER_PRIVATE_KEY ?? "").trim().replace(/^0x/i, "");
  if (requireClaimAuth) {
    if (!/^[0-9a-fA-F]{64}$/.test(rawOwnerPriv) || rawOwnerPriv === PLACEHOLDER_HEX_64) {
      throw new Error(
        "Missing or invalid OWNER_PRIVATE_KEY in .env (expected 0x + 64 hex characters for your owner EOA wallet)"
      );
    }
  }

  const ownerPrivateKey: Hex = /^[0-9a-fA-F]{64}$/.test(rawOwnerPriv)
    ? (`0x${rawOwnerPriv}` as Hex)
    : ("0x" + PLACEHOLDER_HEX_64) as Hex;

  const rawSmartAccount = (process.env.SMART_ACCOUNT_ADDRESS ?? "").trim();
  let smartAccountAddress: Hex | undefined;
  if (rawSmartAccount) {
    if (/^0x[0-9a-fA-F]{40}$/.test(rawSmartAccount)) {
      smartAccountAddress = rawSmartAccount as Hex;
    }
  }

  const swapAmountUsdt = (process.env.SWAP_AMOUNT_USDT ?? "10").trim();
  if (!/^\d+(\.\d+)?$/.test(swapAmountUsdt) || Number(swapAmountUsdt) <= 0) {
    throw new Error(`Invalid SWAP_AMOUNT_USDT "${swapAmountUsdt}" (must be a positive decimal)`);
  }

  const maxSlippageBps = Number(process.env.MAX_SLIPPAGE_BPS ?? "50");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 1 || maxSlippageBps > 1000) {
    throw new Error(
      `Invalid MAX_SLIPPAGE_BPS "${process.env.MAX_SLIPPAGE_BPS}" (must be an integer between 1 and 1000)`
    );
  }

  const trendingCount = Number(process.env.TRENDING_COUNT ?? "5");
  if (!Number.isInteger(trendingCount) || trendingCount < 1 || trendingCount > 50) {
    throw new Error(`Invalid TRENDING_COUNT "${process.env.TRENDING_COUNT}" (must be 1..50)`);
  }

  const quoteAsset = (process.env.QUOTE_ASSET ?? "USDT").trim().toUpperCase();

  const intervalHours = Number(process.env.INTERVAL_HOURS ?? "0");
  if (!Number.isFinite(intervalHours) || intervalHours < 0) {
    throw new Error(`Invalid INTERVAL_HOURS "${process.env.INTERVAL_HOURS}" (must be >= 0)`);
  }

  const pairDelayMs = Number(process.env.PAIR_DELAY_MS ?? "2500");
  const mmHalfSpreadBps = Number(process.env.MM_HALF_SPREAD_BPS ?? "15");
  const mmRequoteDriftBps = Number(process.env.MM_REQUOTE_DRIFT_BPS ?? "8");
  const mmRefreshIntervalMs = Number(process.env.MM_REFRESH_INTERVAL_MS ?? "8000");
  const mmBootstrapInventory =
    (process.env.MM_BOOTSTRAP_INVENTORY ?? "true").toLowerCase() !== "false";
  const mmTurboTurnover =
    (process.env.MM_TURBO_TURNOVER ?? "false").toLowerCase() === "true";
  const subaccountId = (process.env.SUBACCOUNT_ID ?? "").trim() || undefined;
  const apiUrl = (process.env.POLYESTER_API_URL ?? "https://api.testnet.polyester.com")
    .trim()
    .replace(/\/+$/, "");

  const claimOpenBrowser = (process.env.CLAIM_OPEN_BROWSER ?? "true").toLowerCase() !== "false";
  const claimReprobeHours = Number(process.env.CLAIM_REPROBE_HOURS ?? "6");

  let apiKeyRecvWindowMs: number | undefined;
  if (
    process.env.POLYESTER_API_RECV_WINDOW_MS !== undefined &&
    process.env.POLYESTER_API_RECV_WINDOW_MS.trim() !== ""
  ) {
    const rawRecv = Number(process.env.POLYESTER_API_RECV_WINDOW_MS.trim());
    if (!Number.isInteger(rawRecv) || rawRecv < 1 || rawRecv > 60000) {
      throw new Error(
        `Invalid POLYESTER_API_RECV_WINDOW_MS "${process.env.POLYESTER_API_RECV_WINDOW_MS}" (must be an integer between 1 and 60000)`
      );
    }
    apiKeyRecvWindowMs = rawRecv;
  }

  return {
    name: "Main",
    apiKeyId,
    apiPrivateKey: rawApiPriv,
    apiKeyRecvWindowMs,
    ownerPrivateKey,
    smartAccountAddress,
    swapAmountUsdt,
    maxSlippageBps,
    trendingCount,
    quoteAsset,
    intervalHours,
    pairDelayMs: Number.isFinite(pairDelayMs) && pairDelayMs >= 0 ? pairDelayMs : 2500,
    mmHalfSpreadBps:
      Number.isFinite(mmHalfSpreadBps) && mmHalfSpreadBps >= 1 ? mmHalfSpreadBps : 15,
    mmRequoteDriftBps:
      Number.isFinite(mmRequoteDriftBps) && mmRequoteDriftBps >= 1 ? mmRequoteDriftBps : 8,
    mmRefreshIntervalMs:
      Number.isFinite(mmRefreshIntervalMs) && mmRefreshIntervalMs >= 2000
        ? mmRefreshIntervalMs
        : 8000,
    mmBootstrapInventory,
    mmTurboTurnover,
    subaccountId,
    apiUrl,
    dryRun,
    claimOpenBrowser,
    claimReprobeHours:
      Number.isFinite(claimReprobeHours) && claimReprobeHours >= 0.25 ? claimReprobeHours : 6,
  };
}

const WALLETS_FILE_PATH = join(process.cwd(), "wallets.json");

export function loadMultiWalletConfigs(overrides?: {
  dryRun?: boolean;
  requireSwapAuth?: boolean;
  requireClaimAuth?: boolean;
}): BotConfig[] {
  const baseConfig = loadConfig(overrides);
  if (!existsSync(WALLETS_FILE_PATH)) {
    return [baseConfig];
  }

  try {
    const raw = readFileSync(WALLETS_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [baseConfig];
    }

    const configs: BotConfig[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const w = parsed[i];
      const apiKeyId = String(w.apiKeyId ?? "").trim();
      const rawApiPriv = String(w.apiPrivateKey ?? "").trim().replace(/^0x/i, "");
      const rawOwnerPriv = String(w.ownerPrivateKey ?? "").trim().replace(/^0x/i, "");
      const rawSmart = String(w.smartAccountAddress ?? "").trim();

      const ownerPrivateKey: Hex = /^[0-9a-fA-F]{64}$/.test(rawOwnerPriv)
        ? (`0x${rawOwnerPriv}` as Hex)
        : baseConfig.ownerPrivateKey;

      let smartAccountAddress: Hex | undefined = baseConfig.smartAccountAddress;
      if (rawSmart && /^0x[0-9a-fA-F]{40}$/.test(rawSmart)) {
        smartAccountAddress = rawSmart as Hex;
      }

      let walletRecvWindowMs: number | undefined = baseConfig.apiKeyRecvWindowMs;
      if (w.apiKeyRecvWindowMs !== undefined && String(w.apiKeyRecvWindowMs).trim() !== "") {
        const parsedRecv = Number(w.apiKeyRecvWindowMs);
        if (Number.isInteger(parsedRecv) && parsedRecv >= 1 && parsedRecv <= 60000) {
          walletRecvWindowMs = parsedRecv;
        }
      }

      configs.push({
        ...baseConfig,
        name: String(w.name || `Wallet-${i + 1}`).trim(),
        apiKeyId: apiKeyId || baseConfig.apiKeyId,
        apiPrivateKey: rawApiPriv || baseConfig.apiPrivateKey,
        apiKeyRecvWindowMs: walletRecvWindowMs,
        ownerPrivateKey,
        smartAccountAddress,
        subaccountId: w.subaccountId ? String(w.subaccountId).trim() : undefined,
      });
    }

    return configs.length > 0 ? configs : [baseConfig];
  } catch (err) {
    return [baseConfig];
  }
}
