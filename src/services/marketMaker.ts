import { PolyesterClient } from "@polyester/sdk";
import { parseEd25519PrivateKey } from "../lib/apiKeySigner.js";
import { sleep } from "../lib/connect.js";
import { logger } from "../lib/logger.js";
import {
  ansi,
  formatCompactNumber,
  formatPrice,
  pushUiEvent,
  type UiBalanceSummary,
  type UiPairRow,
} from "../lib/terminalUi.js";
import { fromE18, toE18 } from "../lib/u128.js";
import { buildEnvironment } from "./session.js";
import type { TrendingPairCandidate } from "./trending.js";

/**
 * Two-Sided Limit Market Maker (`OrdersService`) for Polyester DEX Testnet.
 *
 * Strategy:
 * 1. Auto-bootstraps base token inventory (via Market IOC BUY) on any trending pair
 *    where current base balance is insufficient to quote the Ask side.
 * 2. Computes Bid & Ask limit prices around the live L2 orderbook mid-price
 *    (`mid * (1 ± halfSpreadBps / 10000)`), quantized to `tickSize` and clamped
 *    strictly inside `bestAsk` / `bestBid` so `postOnly: true` never crosses.
 * 3. Places two-sided resting `limit_gtc` (`postOnly: true`) maker orders via
 *    `client.orders.batchCreate`.
 * 4. Preserves resting order queue priority when mid-price drift is below
 *    `mmRequoteDriftBps`, and cancels + replaces quotes whenever a side fills
 *    or price drifts beyond `mmRequoteDriftBps`.
 * 5. Maintains the exchange Dead-Man Switch (`cancelAllAfter`) and cancels all
 *    resting orders cleanly on shutdown.
 */

export interface ComputedMakerQuotes {
  midPriceE18: bigint;
  bestBidE18: bigint;
  bestAskE18: bigint;
  bidPriceE18: bigint;
  askPriceE18: bigint;
  bidPriceStr: string;
  askPriceStr: string;
  qtyE18: bigint;
  qtyStr: string;
  spreadBps: number;
}

export interface PairMakerQuoteResult {
  pair: string;
  symbolId: number;
  action: "QUOTED" | "HELD" | "DRY_RUN" | "SKIPPED" | "ERROR";
  midPrice: string;
  bidPrice?: string;
  askPrice?: string;
  qty?: string;
  bidOrderId?: string;
  askOrderId?: string;
  bootstrappedBase?: string;
  filledSinceLastTick?: ("BID" | "ASK")[];
  note?: string;
  error?: string;
}

const ONE_E18 = 10n ** 18n;
const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "rejected"]);

export function quantizeDown(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  return (value / step) * step;
}

export function quantizeUp(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  return ((value + step - 1n) / step) * step;
}

export function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/**
 * Pure calculation of Post-Only Bid & Ask prices and base quantity around orderbook mid-price.
 */
export function computeTwoSidedQuotes(params: {
  bestBidE18: bigint;
  bestAskE18: bigint;
  fallbackLastPriceE18: bigint;
  tickSizeE18: bigint;
  stepSizeE18: bigint;
  minQtyE18: bigint;
  minNotionalE18: bigint;
  orderNotionalE18: bigint;
  halfSpreadBps: number;
}): ComputedMakerQuotes {
  const tick = params.tickSizeE18 > 0n ? params.tickSizeE18 : 1n;
  const step = params.stepSizeE18 > 0n ? params.stepSizeE18 : 1n;

  let bestBid = params.bestBidE18;
  let bestAsk = params.bestAskE18;

  if (bestBid <= 0n && bestAsk <= 0n) {
    bestBid = params.fallbackLastPriceE18;
    bestAsk = params.fallbackLastPriceE18;
  } else if (bestBid <= 0n) {
    bestBid = bestAsk;
  } else if (bestAsk <= 0n) {
    bestAsk = bestBid;
  }

  const midPriceE18 = (bestBid + bestAsk) / 2n;
  const halfBps = BigInt(Math.max(1, Math.round(params.halfSpreadBps)));

  const rawBidE18 = (midPriceE18 * (10_000n - halfBps)) / 10_000n;
  const rawAskE18 = (midPriceE18 * (10_000n + halfBps)) / 10_000n;

  let bidPriceE18 = quantizeDown(rawBidE18, tick);
  let askPriceE18 = quantizeUp(rawAskE18, tick);

  // Post-Only safety: Bid must be strictly below bestAsk; Ask must be strictly above bestBid
  if (params.bestAskE18 > tick && bidPriceE18 >= params.bestAskE18) {
    bidPriceE18 = quantizeDown(params.bestAskE18 - tick, tick);
  }
  if (params.bestBidE18 > 0n && askPriceE18 <= params.bestBidE18) {
    askPriceE18 = quantizeUp(params.bestBidE18 + tick, tick);
  }
  if (bidPriceE18 <= 0n) {
    bidPriceE18 = tick;
  }
  if (askPriceE18 <= bidPriceE18) {
    askPriceE18 = bidPriceE18 + tick;
  }

  // Base quantity for target quote notional
  const rawQtyE18 = (params.orderNotionalE18 * ONE_E18) / midPriceE18;
  let qtyE18 = quantizeDown(rawQtyE18, step);
  if (qtyE18 < params.minQtyE18) {
    qtyE18 = quantizeUp(params.minQtyE18, step);
  }
  const bidNotionalE18 = (qtyE18 * bidPriceE18) / ONE_E18;
  if (bidNotionalE18 < params.minNotionalE18) {
    const neededQtyE18 = (params.minNotionalE18 * ONE_E18 + bidPriceE18 - 1n) / bidPriceE18;
    qtyE18 = quantizeUp(neededQtyE18, step);
  }

  const spreadBps =
    midPriceE18 > 0n
      ? Number(((askPriceE18 - bidPriceE18) * 10_000n) / midPriceE18)
      : params.halfSpreadBps * 2;

  return {
    midPriceE18,
    bestBidE18: params.bestBidE18,
    bestAskE18: params.bestAskE18,
    bidPriceE18,
    askPriceE18,
    bidPriceStr: fromE18(bidPriceE18),
    askPriceStr: fromE18(askPriceE18),
    qtyE18,
    qtyStr: fromE18(qtyE18),
    spreadBps,
  };
}

export function createAuthenticatedSpotClient(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
}): PolyesterClient {
  return new PolyesterClient({
    environment: buildEnvironment(params.apiUrl),
    auth: {
      kind: "api-key-ed25519",
      getKeyId: () => params.apiKeyId,
      getSecretKey: () => parseEd25519PrivateKey(params.apiPrivateKey),
    },
  });
}

async function pollOrderUntilTerminal(
  client: PolyesterClient,
  orderId: string,
  subaccountId?: string
) {
  const accountScope = subaccountId ? { account: { subaccountId } } : {};
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt > 0) await sleep(700);
    const details = await client.orders.getDetails({
      orderId,
      includeExecutionHistory: false,
      ...accountScope,
    });
    if (details?.order && TERMINAL_ORDER_STATUSES.has(details.order.status)) {
      return details.order;
    }
  }
  const finalCheck = await client.orders.getDetails({
    orderId,
    includeExecutionHistory: false,
    ...accountScope,
  });
  return finalCheck?.order;
}

/**
 * Trims overweight base inventory back to quote currency via Market IOC
 * if the account holds > 1.8x the required per-side base quantity.
 */
async function rebalanceExcessBaseInventoryIfNeeded(params: {
  client: PolyesterClient;
  pair: TrendingPairCandidate;
  neededBaseE18: bigint;
  stepSizeE18: bigint;
  minQtyE18: bigint;
  availableBaseE18: bigint;
  availableQuoteE18: bigint;
  maxSlippageBps: number;
  subaccountId?: string;
}): Promise<{ newAvailableBaseE18: bigint; newAvailableQuoteE18: bigint }> {
  const { client, pair, neededBaseE18, stepSizeE18, minQtyE18, availableBaseE18, availableQuoteE18 } =
    params;
  const maxTargetBaseE18 = (neededBaseE18 * 250n) / 100n;
  if (availableBaseE18 <= maxTargetBaseE18) {
    return {
      newAvailableBaseE18: availableBaseE18,
      newAvailableQuoteE18: availableQuoteE18,
    };
  }

  // Keep 1.35x of neededBaseE18 for the Ask quote and sell the rest back to USDT
  const keepBaseE18 = (neededBaseE18 * 135n) / 100n;
  const rawSellQtyE18 = availableBaseE18 - keepBaseE18;
  const sellQtyE18 = stepSizeE18 > 0n ? (rawSellQtyE18 / stepSizeE18) * stepSizeE18 : rawSellQtyE18;
  if (sellQtyE18 < minQtyE18 || sellQtyE18 <= 0n) {
    return {
      newAvailableBaseE18: availableBaseE18,
      newAvailableQuoteE18: availableQuoteE18,
    };
  }

  const sellQtyStr = fromE18(sellQtyE18);
  const accountScope = params.subaccountId
    ? { account: { subaccountId: params.subaccountId } }
    : {};

  pushUiEvent(
    "REBALANCE",
    `Trimming overweight ${ansi.white}${pair.baseAsset}${ansi.reset} on ${pair.symbol}: selling ${sellQtyStr} ${pair.baseAsset} -> ${pair.quoteAsset}`
  );

  const created = await client.orders.create({
    symbolId: pair.symbolId,
    side: "sell",
    qty: sellQtyStr,
    feeAsset: "quote",
    execution: {
      type: "market_ioc",
      maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
    },
    clientOrderId: `mm-trim-${pair.symbolId}-${Date.now()}`.slice(0, 64),
    ...accountScope,
  });

  const terminalOrder = await pollOrderUntilTerminal(
    client,
    created.orderId,
    params.subaccountId
  );

  let newBaseE18 = availableBaseE18 - sellQtyE18;
  let newQuoteE18 = availableQuoteE18 + toE18(terminalOrder?.cumQuote ?? "0");

  for (let i = 0; i < 5; i++) {
    await sleep(300);
    const refreshed = await client.balances.list(accountScope);
    const bBase = refreshed.find((b) => b.assetId === pair.baseAssetId);
    const bQuote = refreshed.find((b) => b.assetId === pair.quoteAssetId);
    const bBaseVal = toE18(bBase?.available || "0");
    const bQuoteVal = toE18(bQuote?.available || "0");
    if (bBaseVal < availableBaseE18) {
      newBaseE18 = bBaseVal;
      newQuoteE18 = bQuoteVal;
      break;
    }
  }

  pushUiEvent(
    "REBALANCE",
    `Rebalanced ${pair.symbol}: sold ${formatCompactNumber(sellQtyStr, 4)} ${pair.baseAsset} for +$${formatCompactNumber(terminalOrder?.cumQuote ?? "0", 2)} ${pair.quoteAsset}`
  );

  return {
    newAvailableBaseE18: newBaseE18,
    newAvailableQuoteE18: newQuoteE18,
  };
}

/**
 * Buys initial base inventory via Market IOC when available base balance is below `neededBaseE18`.
 */
async function bootstrapBaseInventoryIfNeeded(params: {
  client: PolyesterClient;
  pair: TrendingPairCandidate;
  neededBaseE18: bigint;
  availableBaseE18: bigint;
  availableQuoteE18: bigint;
  orderNotionalQuote: string;
  maxSlippageBps: number;
  subaccountId?: string;
}): Promise<{
  boughtBaseStr?: string;
  newAvailableBaseE18: bigint;
  newAvailableQuoteE18: bigint;
}> {
  const { client, pair, neededBaseE18, availableBaseE18, availableQuoteE18 } = params;
  // If we hold at least 85% of neededBaseE18, skip paying Taker fees to bootstrap;
  // dynamic Ask sizing will quote the exact available base via 0-fee Maker orders.
  if (availableBaseE18 >= (neededBaseE18 * 85n) / 100n) {
    return {
      newAvailableBaseE18: availableBaseE18,
      newAvailableQuoteE18: availableQuoteE18,
    };
  }

  // Buy only the deficit needed to reach ~1.05x of orderNotionalQuote (instead of a full 1.12x notional every time)
  const targetTotalBaseE18 = (neededBaseE18 * 105n) / 100n;
  const deficitBaseE18 =
    targetTotalBaseE18 > availableBaseE18 ? targetTotalBaseE18 - availableBaseE18 : neededBaseE18;
  const fullNotionalE18 = toE18(params.orderNotionalQuote);
  const rawDeficitQuoteE18 =
    neededBaseE18 > 0n
      ? (fullNotionalE18 * deficitBaseE18) / neededBaseE18
      : (fullNotionalE18 * 105n) / 100n;
  const minBootQuoteE18 = 12n * ONE_E18;
  // Quantize to 2 decimal places (0.01 USDT) because Polyester's maxQuoteDebit supports at most 6 decimal places
  const centStepE18 = 10n ** 16n;
  const targetBuyQuoteE18 = quantizeUp(
    rawDeficitQuoteE18 > minBootQuoteE18 ? rawDeficitQuoteE18 : minBootQuoteE18,
    centStepE18
  );
  if (availableQuoteE18 < targetBuyQuoteE18) {
    pushUiEvent(
      "WARN",
      `Low free ${pair.quoteAsset} ($${formatCompactNumber(fromE18(availableQuoteE18), 2)}) to bootstrap ${pair.baseAsset} ($${formatCompactNumber(fromE18(targetBuyQuoteE18), 2)} needed)`
    );
    return {
      newAvailableBaseE18: availableBaseE18,
      newAvailableQuoteE18: availableQuoteE18,
    };
  }

  const buyQuoteStr = fromE18(targetBuyQuoteE18);
  const accountScope = params.subaccountId
    ? { account: { subaccountId: params.subaccountId } }
    : {};

  let feeAsset: "quote" | "base" = pair.allowBuyFeeFromBase ? "base" : "quote";
  const preview = await client.orders.preview({
    symbolId: pair.symbolId,
    side: "buy",
    maxQuoteDebit: buyQuoteStr,
    feeAsset,
    execution: {
      type: "market_ioc",
      maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
    },
    ...accountScope,
  });

  if (!preview.admissible && preview.rejection?.code === "FEE_ASSET_NOT_ALLOWED") {
    feeAsset = feeAsset === "base" ? "quote" : "base";
  }

  const created = await client.orders.create({
    symbolId: pair.symbolId,
    side: "buy",
    maxQuoteDebit: buyQuoteStr,
    feeAsset,
    execution: {
      type: "market_ioc",
      maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
    },
    clientOrderId: `mm-boot-${pair.symbolId}-${Date.now()}`.slice(0, 64),
    ...accountScope,
  });

  const terminalOrder = await pollOrderUntilTerminal(
    client,
    created.orderId,
    params.subaccountId
  );

  const filledQtyStr = terminalOrder?.cumQty ?? created.resolvedBaseQty ?? "0";
  const spentQuoteStr = terminalOrder?.cumQuote ?? buyQuoteStr;

  // Estimate fallback in case ledger balance projection lags slightly
  let actualAvailableBaseE18 = availableBaseE18 + (toE18(filledQtyStr) * 995n) / 1000n;
  let actualAvailableQuoteE18 =
    availableQuoteE18 > toE18(spentQuoteStr)
      ? availableQuoteE18 - toE18(spentQuoteStr)
      : 0n;

  for (let i = 0; i < 6; i++) {
    await sleep(300);
    const refreshedBalances = await client.balances.list(accountScope);
    const refreshedBase = refreshedBalances.find((b) => b.assetId === pair.baseAssetId);
    const refreshedQuote = refreshedBalances.find((b) => b.assetId === pair.quoteAssetId);
    const baseVal = toE18(refreshedBase?.available || "0");
    const quoteVal = toE18(refreshedQuote?.available || "0");
    if (baseVal > availableBaseE18) {
      actualAvailableBaseE18 = baseVal;
      actualAvailableQuoteE18 = quoteVal;
      break;
    }
  }

  pushUiEvent(
    "REBALANCE",
    `Bootstrapped ${ansi.white}${pair.symbol}${ansi.reset}: bought ${formatCompactNumber(filledQtyStr, 4)} ${pair.baseAsset} ($${formatCompactNumber(spentQuoteStr, 2)} ${pair.quoteAsset})`
  );

  return {
    boughtBaseStr: filledQtyStr,
    newAvailableBaseE18: actualAvailableBaseE18,
    newAvailableQuoteE18: actualAvailableQuoteE18,
  };
}

export class SpotMarketMaker {
  private readonly client: PolyesterClient;
  private readonly apiUrl: string;
  private readonly quoteAsset: string;
  private readonly orderNotionalQuote: string;
  private readonly maxSlippageBps: number;
  private readonly halfSpreadBps: number;
  private readonly requoteDriftBps: number;
  private readonly bootstrapInventory: boolean;
  private readonly turboTurnover: boolean;
  private readonly subaccountId?: string;
  private readonly dryRun: boolean;

  /** Tracks active resting Bid/Ask order IDs per symbolId so we can detect fills across ticks */
  private readonly activePairQuotes = new Map<
    number,
    {
      bidOrderId?: string;
      askOrderId?: string;
      midPriceE18: bigint;
      bidPriceStr: string;
      askPriceStr: string;
      qtyStr: string;
    }
  >();

  public totalMakerOrdersPlaced = 0;
  public totalMakerFillsDetected = 0;
  public sessionVolumeUsd = 0;
  private turboPairIndex = 0;

  constructor(params: {
    apiUrl: string;
    apiKeyId: string;
    apiPrivateKey: string;
    quoteAsset: string;
    orderNotionalQuote: string;
    maxSlippageBps: number;
    halfSpreadBps: number;
    requoteDriftBps: number;
    bootstrapInventory: boolean;
    turboTurnover?: boolean;
    subaccountId?: string;
    dryRun: boolean;
  }) {
    this.apiUrl = params.apiUrl;
    this.quoteAsset = params.quoteAsset;
    this.orderNotionalQuote = params.orderNotionalQuote;
    this.maxSlippageBps = params.maxSlippageBps;
    this.halfSpreadBps = params.halfSpreadBps;
    this.requoteDriftBps = params.requoteDriftBps;
    this.bootstrapInventory = params.bootstrapInventory;
    this.turboTurnover = params.turboTurnover ?? false;
    this.subaccountId = params.subaccountId;
    this.dryRun = params.dryRun;
    this.client = createAuthenticatedSpotClient(params);
  }

  public async initialize(pairs: TrendingPairCandidate[]): Promise<void> {
    await this.client.catalog.ensureReady();
    if (this.dryRun) {
      return;
    }

    const accountScope = this.subaccountId
      ? { account: { subaccountId: this.subaccountId } }
      : {};

    // Liquidate any non-trending base tokens (e.g. from previous runs) back to USDT
    try {
      const targetSymbolIds = new Set(pairs.map((p) => p.symbolId));
      const allOpen = await this.client.orders.listOpen(accountScope);
      const staleSymbolIds = [
        ...new Set(
          allOpen.orders
            .map((o) => o.symbolId)
            .filter((sid) => !targetSymbolIds.has(sid))
        ),
      ];
      if (staleSymbolIds.length > 0) {
        await this.client.orders.cancelAll({
          symbolIds: staleSymbolIds,
          ...accountScope,
        });
        await sleep(400);
      }

      const balances = await this.client.balances.list(accountScope);
      const targetBaseAssetIds = new Set(pairs.map((p) => p.baseAssetId));
      const quoteAssetUpper = this.quoteAsset.toUpperCase();
      const allCatalogPairs = this.client.catalog.market.listPairs();

      for (const b of balances) {
        const availE18 = toE18(b.available || "0");
        if (availE18 <= 0n || targetBaseAssetIds.has(b.assetId)) continue;
        const sellPair = allCatalogPairs.find(
          (cp) =>
            cp.baseAsset.ledgerId === b.assetId &&
            cp.quoteAsset.symbol.toUpperCase() === quoteAssetUpper &&
            cp.status === "enabled"
        );
        if (!sellPair) continue;
        const sellQtyE18 = quantizeDown(availE18, toE18(sellPair.stepSize));
        if (sellQtyE18 < toE18(sellPair.minQtyBase)) continue;
        const sellQtyStr = fromE18(sellQtyE18);
        try {
          const sold = await this.client.orders.create({
            symbolId: sellPair.symbolId,
            side: "sell",
            qty: sellQtyStr,
            feeAsset: "quote",
            execution: {
              type: "market_ioc",
              maxSlippage: { kind: "bps", bps: Math.max(100, this.maxSlippageBps) },
            },
            clientOrderId: `mm-liq-${sellPair.symbolId}-${Date.now()}`.slice(0, 64),
            ...accountScope,
          });
          const term = await pollOrderUntilTerminal(
            this.client,
            sold.orderId,
            this.subaccountId
          );
          const gotUsd = Number(term?.cumQuote ?? "0");
          if (gotUsd > 0) this.sessionVolumeUsd += gotUsd;
          pushUiEvent(
            "REBALANCE",
            `Liquidated non-top asset ${ansi.white}${sellPair.symbol}${ansi.reset}: sold ${formatCompactNumber(sellQtyStr, 4)} -> +$${formatCompactNumber(String(gotUsd), 2)} ${this.quoteAsset}`
          );
        } catch {
          // ignore if below min notional
        }
      }
    } catch {
      // non-fatal cleanup
    }

    // Arm 60-second Dead-Man Switch heartbeat
    try {
      await this.client.orders.cancelAllAfter({
        timeoutSec: 60,
        ...accountScope,
      });
    } catch {
      // non-fatal if dead-man switch is unsupported on policy
    }
  }

  public async refreshDeadManSwitch(): Promise<void> {
    if (this.dryRun) return;
    try {
      const accountScope = this.subaccountId
        ? { account: { subaccountId: this.subaccountId } }
        : {};
      await this.client.orders.cancelAllAfter({
        timeoutSec: 60,
        ...accountScope,
      });
    } catch {
      // ignore heartbeat errors
    }
  }

  public async shutdown(pairs: TrendingPairCandidate[]): Promise<void> {
    if (this.dryRun) return;
    const accountScope = this.subaccountId
      ? { account: { subaccountId: this.subaccountId } }
      : {};
    try {
      const symbolIds = pairs.map((p) => p.symbolId);
      const res = await this.client.orders.cancelAll({
        symbolIds,
        ...accountScope,
      });
      await this.client.orders.cancelAllAfter({
        timeoutSec: 0,
        ...accountScope,
      });
      logger.info(`Shutdown cleanup complete: canceled ${res.totalCanceled} resting maker order(s).`);
    } catch (err) {
      logger.warn(
        `Shutdown cancelAll warning: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private loggedAutoSizeNote = false;

  /**
   * Executes one full Market-Making tick across all target trending pairs:
   * - Checks live orderbook & existing resting orders
   * - Detects fills on resting Bid / Ask orders
   * - Holds existing quotes if healthy & within drift threshold
   * - Bootstraps/rebalances base inventory if needed and places new Post-Only Bid + Ask quotes
   */
  public async runTick(pairs: TrendingPairCandidate[]): Promise<{
    results: PairMakerQuoteResult[];
    uiRows: UiPairRow[];
    balances: UiBalanceSummary;
    effectiveOrderSizeQuote: string;
  }> {
    await this.refreshDeadManSwitch();

    const accountScope = this.subaccountId
      ? { account: { subaccountId: this.subaccountId } }
      : {};

    const [balances, openOrdersPage] = await Promise.all([
      this.client.balances.list(accountScope),
      this.client.orders.listOpen({
        symbolId: pairs.map((p) => p.symbolId),
        ...accountScope,
      }),
    ]);

    const availableByAssetId = new Map<number, bigint>();
    const reservedByAssetId = new Map<number, bigint>();
    const tradingByAssetId = new Map<number, bigint>();
    for (const b of balances) {
      availableByAssetId.set(b.assetId, toE18(b.available || "0"));
      reservedByAssetId.set(b.assetId, toE18(b.reserved || "0"));
      tradingByAssetId.set(b.assetId, toE18(b.trading || "0"));
    }

    const quoteAssetId = pairs[0]?.quoteAssetId ?? 2;
    let totalEquityE18 = tradingByAssetId.get(quoteAssetId) ?? 0n;
    for (const p of pairs) {
      const baseTrad = tradingByAssetId.get(p.baseAssetId) ?? 0n;
      const lastPx = toE18(p.lastPrice || "0");
      totalEquityE18 += (baseTrad * lastPx) / ONE_E18;
    }

    // Auto-cap per-side order notional to ~82% of account equity across N*2 sides (or 60% if Turbo Taker is enabled)
    // so capital goes into 0-fee Post-Only Maker limit quotes instead of idle buffer.
    const configuredNotionalE18 = toE18(this.orderNotionalQuote);
    const totalSides = BigInt(Math.max(2, pairs.length * 2));
    const equityUsagePct = this.turboTurnover ? 60n : 82n;
    const maxSafePerSideE18 =
      totalEquityE18 > 0n
        ? quantizeDown((totalEquityE18 * equityUsagePct) / (100n * totalSides), ONE_E18)
        : configuredNotionalE18;

    const effectiveNotionalE18 =
      maxSafePerSideE18 > 0n && configuredNotionalE18 > maxSafePerSideE18
        ? maxSafePerSideE18 >= 10n * ONE_E18
          ? maxSafePerSideE18
          : configuredNotionalE18
        : configuredNotionalE18;
    const effectiveOrderNotionalStr = fromE18(effectiveNotionalE18);

    if (!this.loggedAutoSizeNote && effectiveNotionalE18 < configuredNotionalE18) {
      this.loggedAutoSizeNote = true;
      pushUiEvent(
        "INFO",
        `Auto-scaled per-side quote from $${this.orderNotionalQuote} -> $${effectiveOrderNotionalStr} ${this.quoteAsset} to fit ~$${formatCompactNumber(fromE18(totalEquityE18), 0)} equity across ${pairs.length} pairs (${pairs.length * 2} sides)`
      );
    }

    const openBySymbolId = new Map<number, typeof openOrdersPage.orders>();
    for (const o of openOrdersPage.orders) {
      const list = openBySymbolId.get(o.symbolId) ?? [];
      list.push(o);
      openBySymbolId.set(o.symbolId, list);
    }

    const catalogPairById = new Map(
      this.client.catalog.market.listPairs().map((p) => [p.symbolId, p])
    );

    const results: PairMakerQuoteResult[] = [];
    const uiRows: UiPairRow[] = [];

    // Pass 1: Trim any overweight base inventory (> 1.8x target per-side size) FIRST
    // so excess base tokens are converted back to USDT before quoting/bootstrapping other pairs.
    if (!this.dryRun && this.bootstrapInventory) {
      for (const pair of pairs) {
        try {
          const catalogPair = catalogPairById.get(pair.symbolId);
          if (!catalogPair) continue;
          const lastPxE18 = toE18(pair.lastPrice || "0");
          if (lastPxE18 <= 0n) continue;
          const approxTargetBaseE18 = quantizeDown(
            (effectiveNotionalE18 * ONE_E18) / lastPxE18,
            toE18(catalogPair.stepSize)
          );
          const tradingBaseE18 = tradingByAssetId.get(pair.baseAssetId) ?? 0n;
          if (approxTargetBaseE18 > 0n && tradingBaseE18 > (approxTargetBaseE18 * 250n) / 100n) {
            const pairOpen = openBySymbolId.get(pair.symbolId) ?? [];
            if (pairOpen.length > 0) {
              this.activePairQuotes.delete(pair.symbolId);
              await this.client.orders.cancelAll({
                symbolIds: [pair.symbolId],
                ...accountScope,
              });
              openBySymbolId.set(pair.symbolId, []);
              await sleep(400);
              const refreshed = await this.client.balances.list(accountScope);
              for (const b of refreshed) {
                availableByAssetId.set(b.assetId, toE18(b.available || "0"));
                reservedByAssetId.set(b.assetId, toE18(b.reserved || "0"));
                tradingByAssetId.set(b.assetId, toE18(b.trading || "0"));
              }
            }
            const availBaseNowE18 = availableByAssetId.get(pair.baseAssetId) ?? 0n;
            const availQuoteNowE18 = availableByAssetId.get(pair.quoteAssetId) ?? 0n;
            const trimmed = await rebalanceExcessBaseInventoryIfNeeded({
              client: this.client,
              pair,
              neededBaseE18: approxTargetBaseE18,
              stepSizeE18: toE18(catalogPair.stepSize),
              minQtyE18: toE18(catalogPair.minQtyBase),
              availableBaseE18: availBaseNowE18,
              availableQuoteE18: availQuoteNowE18,
              maxSlippageBps: this.maxSlippageBps,
              subaccountId: this.subaccountId,
            });
            availableByAssetId.set(pair.baseAssetId, trimmed.newAvailableBaseE18);
            tradingByAssetId.set(pair.baseAssetId, trimmed.newAvailableBaseE18);
            availableByAssetId.set(pair.quoteAssetId, trimmed.newAvailableQuoteE18);
          }
        } catch (err) {
          pushUiEvent(
            "WARN",
            `Pre-tick rebalance warning on ${pair.symbol}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    const turboPairSymbolId =
      !this.dryRun && this.turboTurnover && pairs.length > 0
        ? pairs[this.turboPairIndex++ % pairs.length]?.symbolId
        : undefined;

    for (const pair of pairs) {
      try {
        const catalogPair = catalogPairById.get(pair.symbolId);
        if (!catalogPair) {
          results.push({
            pair: pair.symbol,
            symbolId: pair.symbolId,
            action: "SKIPPED",
            midPrice: pair.lastPrice,
            note: "Symbol missing from catalog",
          });
          continue;
        }

        const book = await this.client.orderbook.get({
          symbolId: pair.symbolId,
          depth: 10,
        });

        const bestBidE18 = book.bids[0]?.price ? toE18(book.bids[0].price) : 0n;
        const bestAskE18 = book.asks[0]?.price ? toE18(book.asks[0].price) : 0n;
        const fallbackLastE18 = toE18(pair.lastPrice);

        const quotes = computeTwoSidedQuotes({
          bestBidE18,
          bestAskE18,
          fallbackLastPriceE18: fallbackLastE18,
          tickSizeE18: toE18(catalogPair.tickSize),
          stepSizeE18: toE18(catalogPair.stepSize),
          minQtyE18: toE18(catalogPair.minQtyBase),
          minNotionalE18: toE18(catalogPair.minNotionalQuote),
          orderNotionalE18: effectiveNotionalE18,
          halfSpreadBps: this.halfSpreadBps,
        });

        const baseTotalNowE18 = tradingByAssetId.get(pair.baseAssetId) ?? 0n;
        const baseValUsdNowE18 = (baseTotalNowE18 * quotes.midPriceE18) / ONE_E18;

        if (this.dryRun) {
          results.push({
            pair: pair.symbol,
            symbolId: pair.symbolId,
            action: "DRY_RUN",
            midPrice: fromE18(quotes.midPriceE18),
            bidPrice: quotes.bidPriceStr,
            askPrice: quotes.askPriceStr,
            qty: quotes.qtyStr,
          });
          uiRows.push({
            pair: pair.symbol,
            baseAsset: pair.baseAsset,
            quoteAsset: pair.quoteAsset,
            action: "DRY_RUN",
            midPrice: fromE18(quotes.midPriceE18),
            bidPrice: quotes.bidPriceStr,
            askPrice: quotes.askPriceStr,
            bidQty: quotes.qtyStr,
            askQty: quotes.qtyStr,
            spreadBps: quotes.spreadBps,
            driftBps: 0,
            requoteDriftBps: this.requoteDriftBps,
            baseBalanceTotal: fromE18(baseTotalNowE18),
            baseValueUsd: fromE18(baseValUsdNowE18),
          });
          continue;
        }

        // Check existing resting orders on this pair
        const openOrders = openBySymbolId.get(pair.symbolId) ?? [];
        const restingBids = openOrders.filter((o) => o.side === "buy");
        const restingAsks = openOrders.filter((o) => o.side === "sell");
        const prevTracked = this.activePairQuotes.get(pair.symbolId);

        const filledSides: ("BID" | "ASK")[] = [];
        if (prevTracked?.bidOrderId && restingBids.length === 0) {
          filledSides.push("BID");
          this.totalMakerFillsDetected++;
        }
        if (prevTracked?.askOrderId && restingAsks.length === 0) {
          filledSides.push("ASK");
          this.totalMakerFillsDetected++;
        }

        if (filledSides.length > 0) {
          const fillVolUsd = Number(effectiveOrderNotionalStr) * filledSides.length;
          this.sessionVolumeUsd += fillVolUsd;
          pushUiEvent(
            "FILL",
            `${ansi.bold}${ansi.white}${pair.symbol}${ansi.reset} Maker ${ansi.brightGreen}${filledSides.join(" & ")}${ansi.reset} filled (+$${formatCompactNumber(String(fillVolUsd), 0)} vol, Total Fills: ${this.totalMakerFillsDetected})`
          );
        }

        // Compute drift from existing resting Bid/Ask mid-price
        const referenceMidE18 =
          prevTracked?.midPriceE18 ??
          (restingBids[0] && restingAsks[0]
            ? (toE18(restingBids[0].price || "0") + toE18(restingAsks[0].price || "0")) / 2n
            : 0n);

        const driftBps =
          quotes.midPriceE18 > 0n && referenceMidE18 > 0n
            ? Number(
                (absDiff(quotes.midPriceE18, referenceMidE18) * 10_000n) /
                  quotes.midPriceE18
              )
            : 0;

        // Also check if resting order quantity is wildly out of sync with effectiveNotional (e.g. > 2x)
        const restingBidQtyE18 = restingBids[0]?.totalQty ? toE18(restingBids[0].totalQty) : 0n;
        const sizeMismatch =
          restingBidQtyE18 > 0n &&
          (restingBidQtyE18 > (quotes.qtyE18 * 180n) / 100n ||
            restingBidQtyE18 < (quotes.qtyE18 * 50n) / 100n);

        const isTurboPair = pair.symbolId === turboPairSymbolId;

        // If both Bid and Ask are currently resting and within drift & size bounds (and not selected for Turbo turnover this tick), hold them
        if (restingBids.length === 1 && restingAsks.length === 1 && !sizeMismatch && !isTurboPair) {
          if (driftBps < this.requoteDriftBps) {
            const heldBidPx = restingBids[0].price ?? quotes.bidPriceStr;
            const heldAskPx = restingAsks[0].price ?? quotes.askPriceStr;
            const heldSpreadBps =
              quotes.midPriceE18 > 0n
                ? Number(
                    ((toE18(heldAskPx) - toE18(heldBidPx)) * 10_000n) /
                      quotes.midPriceE18
                  )
                : quotes.spreadBps;

            this.activePairQuotes.set(pair.symbolId, {
              bidOrderId: restingBids[0].orderId,
              askOrderId: restingAsks[0].orderId,
              midPriceE18: referenceMidE18,
              bidPriceStr: heldBidPx,
              askPriceStr: heldAskPx,
              qtyStr: restingBids[0].totalQty,
            });

            results.push({
              pair: pair.symbol,
              symbolId: pair.symbolId,
              action: "HELD",
              midPrice: fromE18(quotes.midPriceE18),
              bidPrice: heldBidPx,
              askPrice: heldAskPx,
              qty: restingBids[0].totalQty,
              bidOrderId: restingBids[0].orderId,
              askOrderId: restingAsks[0].orderId,
            });

            uiRows.push({
              pair: pair.symbol,
              baseAsset: pair.baseAsset,
              quoteAsset: pair.quoteAsset,
              action: "HELD",
              midPrice: fromE18(quotes.midPriceE18),
              bidPrice: heldBidPx,
              askPrice: heldAskPx,
              bidQty: restingBids[0].totalQty,
              askQty: restingAsks[0].totalQty,
              bidOrderId: restingBids[0].orderId,
              askOrderId: restingAsks[0].orderId,
              spreadBps: heldSpreadBps,
              driftBps,
              requoteDriftBps: this.requoteDriftBps,
              baseBalanceTotal: fromE18(baseTotalNowE18),
              baseValueUsd: fromE18(baseValUsdNowE18),
            });
            continue;
          }

          if (!isTurboPair) {
            pushUiEvent(
              "QUOTE",
              `Requoting ${ansi.white}${pair.symbol}${ansi.reset}: mid drifted ${driftBps} bps (>= ${this.requoteDriftBps} bps)`
            );
          }
        }

        // Clear tracked IDs before canceling so canceled orders are never miscounted as fills
        this.activePairQuotes.delete(pair.symbolId);

        // Cancel any open orders on this pair before placing fresh Bid + Ask quotes
        if (openOrders.length > 0) {
          await this.client.orders.cancelAll({
            symbolIds: [pair.symbolId],
            ...accountScope,
          });
          await sleep(450);
          const refreshedAfterCancel = await this.client.balances.list(accountScope);
          for (const b of refreshedAfterCancel) {
            availableByAssetId.set(b.assetId, toE18(b.available || "0"));
            reservedByAssetId.set(b.assetId, toE18(b.reserved || "0"));
            tradingByAssetId.set(b.assetId, toE18(b.trading || "0"));
          }
        }

        // Active Turbo Volume Booster on the rotating pair of this tick
        if (isTurboPair) {
          const quoteAvailForTurbo = availableByAssetId.get(pair.quoteAssetId) ?? 0n;
          const maxTurboQuoteE18 = 260n * ONE_E18;
          const usableTurboQuoteE18 = quantizeDown(
            (quoteAvailForTurbo * 75n) / 100n > maxTurboQuoteE18
              ? maxTurboQuoteE18
              : (quoteAvailForTurbo * 75n) / 100n,
            ONE_E18
          );

          if (usableTurboQuoteE18 >= 25n * ONE_E18) {
            try {
              const buyQuoteStr = fromE18(usableTurboQuoteE18);
              const buyFeeAsset: "quote" | "base" = pair.allowBuyFeeFromBase ? "base" : "quote";
              const leg1 = await this.client.orders.create({
                symbolId: pair.symbolId,
                side: "buy",
                maxQuoteDebit: buyQuoteStr,
                feeAsset: buyFeeAsset,
                execution: {
                  type: "market_ioc",
                  maxSlippage: { kind: "bps", bps: Math.max(80, this.maxSlippageBps) },
                },
                clientOrderId: `mm-vol1-${pair.symbolId}-${Date.now()}`.slice(0, 64),
                ...accountScope,
              });
              const term1 = await pollOrderUntilTerminal(
                this.client,
                leg1.orderId,
                this.subaccountId
              );
              const boughtQtyStr = term1?.cumQty ?? leg1.resolvedBaseQty ?? "0";
              const spentUsd = Number(term1?.cumQuote ?? buyQuoteStr);
              const boughtQtyE18 = quantizeDown(
                (toE18(boughtQtyStr) * 995n) / 1000n,
                toE18(catalogPair.stepSize)
              );

              if (boughtQtyE18 >= toE18(catalogPair.minQtyBase)) {
                await sleep(250);
                const sellQtyStr = fromE18(boughtQtyE18);
                const leg2 = await this.client.orders.create({
                  symbolId: pair.symbolId,
                  side: "sell",
                  qty: sellQtyStr,
                  feeAsset: "quote",
                  execution: {
                    type: "market_ioc",
                    maxSlippage: { kind: "bps", bps: Math.max(80, this.maxSlippageBps) },
                  },
                  clientOrderId: `mm-vol2-${pair.symbolId}-${Date.now()}`.slice(0, 64),
                  ...accountScope,
                });
                const term2 = await pollOrderUntilTerminal(
                  this.client,
                  leg2.orderId,
                  this.subaccountId
                );
                const returnedUsd = Number(term2?.cumQuote ?? buyQuoteStr);
                const roundTripVol = spentUsd + returnedUsd;
                this.sessionVolumeUsd += roundTripVol;
                this.totalMakerOrdersPlaced += 2;

                pushUiEvent(
                  "FILL",
                  `${ansi.bold}${ansi.white}${pair.symbol}${ansi.reset} Turbo Turnover: ${formatCompactNumber(sellQtyStr, 4)} ${pair.baseAsset} (${ansi.brightYellow}+$${formatCompactNumber(String(roundTripVol), 0)} vol${ansi.reset})`
                );

                await sleep(300);
                const afterTurboBalances = await this.client.balances.list(accountScope);
                for (const b of afterTurboBalances) {
                  availableByAssetId.set(b.assetId, toE18(b.available || "0"));
                  reservedByAssetId.set(b.assetId, toE18(b.reserved || "0"));
                  tradingByAssetId.set(b.assetId, toE18(b.trading || "0"));
                }
              }
            } catch {
              // ignore transient turbo turnover error and proceed to quoting
            }
          }
        }

        // Always use `available` (unlocked) balance when placing orders or rebalancing
        const freeBaseE18 = availableByAssetId.get(pair.baseAssetId) ?? 0n;
        let freeQuoteE18 = availableByAssetId.get(pair.quoteAssetId) ?? 0n;

        let bootstrappedBase: string | undefined;
        let currentBaseE18 = freeBaseE18;

        if (this.bootstrapInventory) {
          if (currentBaseE18 > (quotes.qtyE18 * 250n) / 100n) {
            const trimmed = await rebalanceExcessBaseInventoryIfNeeded({
              client: this.client,
              pair,
              neededBaseE18: quotes.qtyE18,
              stepSizeE18: toE18(catalogPair.stepSize),
              minQtyE18: toE18(catalogPair.minQtyBase),
              availableBaseE18: currentBaseE18,
              availableQuoteE18: freeQuoteE18,
              maxSlippageBps: this.maxSlippageBps,
              subaccountId: this.subaccountId,
            });
            if (trimmed.newAvailableQuoteE18 > freeQuoteE18) {
              this.sessionVolumeUsd += Number(fromE18(trimmed.newAvailableQuoteE18 - freeQuoteE18));
            }
            currentBaseE18 = trimmed.newAvailableBaseE18;
            freeQuoteE18 = trimmed.newAvailableQuoteE18;
            availableByAssetId.set(pair.quoteAssetId, freeQuoteE18);
            availableByAssetId.set(pair.baseAssetId, currentBaseE18);
            tradingByAssetId.set(pair.baseAssetId, currentBaseE18);
          } else if (currentBaseE18 < (quotes.qtyE18 * 85n) / 100n) {
            const boot = await bootstrapBaseInventoryIfNeeded({
              client: this.client,
              pair,
              neededBaseE18: quotes.qtyE18,
              availableBaseE18: currentBaseE18,
              availableQuoteE18: freeQuoteE18,
              orderNotionalQuote: effectiveOrderNotionalStr,
              maxSlippageBps: this.maxSlippageBps,
              subaccountId: this.subaccountId,
            });
            bootstrappedBase = boot.boughtBaseStr;
            if (bootstrappedBase) {
              this.sessionVolumeUsd += Number(effectiveOrderNotionalStr) * 1.12;
            }
            currentBaseE18 = boot.newAvailableBaseE18;
            freeQuoteE18 = boot.newAvailableQuoteE18;
            availableByAssetId.set(pair.quoteAssetId, freeQuoteE18);
            availableByAssetId.set(pair.baseAssetId, currentBaseE18);
            tradingByAssetId.set(pair.baseAssetId, currentBaseE18);
          }
        }

        // Build two-sided Post-Only Limit GTC batch items
        const batchItems: {
          symbolId: number;
          side: "buy" | "sell";
          qty: string;
          feeAsset: "quote" | "base";
          execution: { type: "limit_gtc"; price: string; postOnly: boolean };
          clientOrderId: string;
        }[] = [];

        const tsTag = Date.now().toString(36);
        const bidFeeAsset: "quote" | "base" = pair.allowBuyFeeFromBase ? "base" : "quote";
        const bidNotionalE18 = (quotes.qtyE18 * quotes.bidPriceE18) / ONE_E18;
        const quoteAvailNow = availableByAssetId.get(pair.quoteAssetId) ?? 0n;
        const requiredQuoteForBidE18 =
          bidFeeAsset === "quote" ? (bidNotionalE18 * 1003n) / 1000n : bidNotionalE18;

        // If available USDT is slightly below requiredQuoteForBidE18, dynamically size Bid to available USDT
        let bidQtyStr = quotes.qtyStr;
        let actualBidNotionalE18 = requiredQuoteForBidE18;
        if (
          quoteAvailNow < requiredQuoteForBidE18 &&
          quoteAvailNow >= toE18(catalogPair.minNotionalQuote) * 2n
        ) {
          const reducedBidQtyE18 = quantizeDown(
            ((quoteAvailNow * 95n) / 100n * ONE_E18) / quotes.bidPriceE18,
            toE18(catalogPair.stepSize)
          );
          if (reducedBidQtyE18 >= toE18(catalogPair.minQtyBase)) {
            bidQtyStr = fromE18(reducedBidQtyE18);
            const rawNotional = (reducedBidQtyE18 * quotes.bidPriceE18) / ONE_E18;
            actualBidNotionalE18 =
              bidFeeAsset === "quote" ? (rawNotional * 1003n) / 1000n : rawNotional;
          }
        }

        if (quoteAvailNow >= actualBidNotionalE18) {
          batchItems.push({
            symbolId: pair.symbolId,
            side: "buy",
            qty: bidQtyStr,
            feeAsset: bidFeeAsset,
            execution: {
              type: "limit_gtc",
              price: quotes.bidPriceStr,
              postOnly: true,
            },
            clientOrderId: `mm-bid-${pair.symbolId}-${tsTag}`.slice(0, 64),
          });
          availableByAssetId.set(pair.quoteAssetId, quoteAvailNow - actualBidNotionalE18);
          reservedByAssetId.set(
            pair.quoteAssetId,
            (reservedByAssetId.get(pair.quoteAssetId) ?? 0n) + actualBidNotionalE18
          );
        }

        // If available base is slightly below quotes.qtyE18, dynamically size Ask to available base
        let askQtyStr = quotes.qtyStr;
        let canPlaceAsk = currentBaseE18 >= quotes.qtyE18;
        if (!canPlaceAsk && currentBaseE18 >= toE18(catalogPair.minQtyBase)) {
          const usableBaseE18 = quantizeDown(currentBaseE18, toE18(catalogPair.stepSize));
          const usableNotionalE18 = (usableBaseE18 * quotes.askPriceE18) / ONE_E18;
          if (
            usableBaseE18 >= toE18(catalogPair.minQtyBase) &&
            usableNotionalE18 >= toE18(catalogPair.minNotionalQuote)
          ) {
            askQtyStr = fromE18(usableBaseE18);
            canPlaceAsk = true;
          }
        }

        if (canPlaceAsk) {
          batchItems.push({
            symbolId: pair.symbolId,
            side: "sell",
            qty: askQtyStr,
            feeAsset: "quote",
            execution: {
              type: "limit_gtc",
              price: quotes.askPriceStr,
              postOnly: true,
            },
            clientOrderId: `mm-ask-${pair.symbolId}-${tsTag}`.slice(0, 64),
          });
        }

        const updatedBaseTotalE18 = tradingByAssetId.get(pair.baseAssetId) ?? currentBaseE18;
        const updatedBaseValUsdE18 = (updatedBaseTotalE18 * quotes.midPriceE18) / ONE_E18;

        if (batchItems.length === 0) {
          pushUiEvent(
            "WARN",
            `Skipped ${pair.symbol}: insufficient free ${pair.quoteAsset} ($${formatCompactNumber(fromE18(quoteAvailNow), 2)}) & ${pair.baseAsset} (${formatCompactNumber(fromE18(currentBaseE18), 4)})`
          );
          results.push({
            pair: pair.symbol,
            symbolId: pair.symbolId,
            action: "SKIPPED",
            midPrice: fromE18(quotes.midPriceE18),
            note: "Insufficient quote and base balances to place Bid or Ask",
          });
          uiRows.push({
            pair: pair.symbol,
            baseAsset: pair.baseAsset,
            quoteAsset: pair.quoteAsset,
            action: "SKIPPED",
            midPrice: fromE18(quotes.midPriceE18),
            spreadBps: quotes.spreadBps,
            driftBps,
            requoteDriftBps: this.requoteDriftBps,
            baseBalanceTotal: fromE18(updatedBaseTotalE18),
            baseValueUsd: fromE18(updatedBaseValUsdE18),
          });
          continue;
        }

        const batchRes = await this.client.orders.batchCreate({
          items: batchItems,
          ...accountScope,
        });

        let bidOrderId: string | undefined;
        let askOrderId: string | undefined;

        for (let idx = 0; idx < batchItems.length; idx++) {
          const item = batchItems[idx];
          const outcome = batchRes.results[idx];
          if (outcome?.status === "accepted") {
            this.totalMakerOrdersPlaced++;
            if (item.side === "buy") bidOrderId = outcome.orderId;
            if (item.side === "sell") askOrderId = outcome.orderId;
          } else if (outcome?.status === "rejected") {
            pushUiEvent(
              "WARN",
              `Maker ${item.side.toUpperCase()} rejected on ${pair.symbol} (@ ${item.execution.price}): ${outcome.error?.code ?? "REJECTED"}`
            );
          }
        }

        this.activePairQuotes.set(pair.symbolId, {
          bidOrderId,
          askOrderId,
          midPriceE18: quotes.midPriceE18,
          bidPriceStr: quotes.bidPriceStr,
          askPriceStr: quotes.askPriceStr,
          qtyStr: quotes.qtyStr,
        });

        pushUiEvent(
          "QUOTE",
          `Quoted ${ansi.bold}${ansi.white}${pair.symbol}${ansi.reset} - Bid ${ansi.brightGreen}${formatPrice(quotes.bidPriceStr)}${ansi.reset} / Ask ${ansi.brightRed}${formatPrice(quotes.askPriceStr)}${ansi.reset} (${quotes.spreadBps}bp)`
        );

        results.push({
          pair: pair.symbol,
          symbolId: pair.symbolId,
          action: "QUOTED",
          midPrice: fromE18(quotes.midPriceE18),
          bidPrice: bidOrderId ? quotes.bidPriceStr : undefined,
          askPrice: askOrderId ? quotes.askPriceStr : undefined,
          qty: quotes.qtyStr,
          bidOrderId,
          askOrderId,
          bootstrappedBase,
          filledSinceLastTick: filledSides.length > 0 ? filledSides : undefined,
        });

        uiRows.push({
          pair: pair.symbol,
          baseAsset: pair.baseAsset,
          quoteAsset: pair.quoteAsset,
          action: "QUOTED",
          midPrice: fromE18(quotes.midPriceE18),
          bidPrice: bidOrderId ? quotes.bidPriceStr : undefined,
          askPrice: askOrderId ? quotes.askPriceStr : undefined,
          bidQty: bidOrderId ? bidQtyStr : undefined,
          askQty: askOrderId ? askQtyStr : undefined,
          bidOrderId,
          askOrderId,
          spreadBps: quotes.spreadBps,
          driftBps: 0,
          requoteDriftBps: this.requoteDriftBps,
          baseBalanceTotal: fromE18(updatedBaseTotalE18),
          baseValueUsd: fromE18(updatedBaseValUsdE18),
          filledSinceLastTick: filledSides.length > 0 ? filledSides : undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushUiEvent("ERROR", `Market-making error on ${pair.symbol}: ${msg}`);
        results.push({
          pair: pair.symbol,
          symbolId: pair.symbolId,
          action: "ERROR",
          midPrice: pair.lastPrice,
          error: msg,
        });
        uiRows.push({
          pair: pair.symbol,
          baseAsset: pair.baseAsset,
          quoteAsset: pair.quoteAsset,
          action: "ERROR",
          midPrice: pair.lastPrice,
          requoteDriftBps: this.requoteDriftBps,
          baseBalanceTotal: "0",
          baseValueUsd: "0",
          error: msg,
        });
      }
    }

    const finalQuoteAvail = availableByAssetId.get(quoteAssetId) ?? 0n;
    const finalQuoteHeld = reservedByAssetId.get(quoteAssetId) ?? 0n;
    const finalQuoteTotal = tradingByAssetId.get(quoteAssetId) ?? finalQuoteAvail + finalQuoteHeld;

    return {
      results,
      uiRows,
      balances: {
        quoteAsset: this.quoteAsset,
        quoteAvailable: fromE18(finalQuoteAvail),
        quoteHeld: fromE18(finalQuoteHeld),
        quoteTotal: fromE18(finalQuoteTotal),
        estimatedTotalEquityUsd: fromE18(totalEquityE18),
      },
      effectiveOrderSizeQuote: effectiveOrderNotionalStr,
    };
  }
}
