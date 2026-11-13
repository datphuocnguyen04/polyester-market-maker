import { PolyesterClient } from "@polyester/sdk";
import { parseEd25519PrivateKey } from "../lib/apiKeySigner.js";
import {
  callConnectJsonWithApiKey,
  ConnectRpcError,
  sleep,
} from "../lib/connect.js";
import { logger } from "../lib/logger.js";
import { fromE18, fromU128, toE18, toU128, type U128Json } from "../lib/u128.js";
import { buildEnvironment } from "./session.js";
import type { TrendingPairCandidate } from "./trending.js";

/**
 * ConnectRPC `swap.v1.SwapService` implementation for quoting, creating,
 * polling, and executing round-trip swaps (`QUOTE -> BASE -> QUOTE`).
 *
 * Per Polyester Swap documentation:
 * - Swap is available through ConnectRPC at `api.testnet.polyester.com`
 *   (`swap.v1.SwapService/QuoteSwap`, `CreateSwap`, `GetSwap`).
 * - All Swap amounts use 18-decimal integers (`U128` `{ hi, lo }`), regardless
 *   of the asset's spot order scale.
 * - Quotes expire 30 seconds after `quoted_at`.
 * - Each logical conversion uses a unique `idempotency_key` (`^[A-Za-z0-9._:-]{1,128}$`).
 *   If `CreateSwap` times out or returns `UNAVAILABLE`, retrying with the same
 *   `idempotency_key` and terms returns the existing Swap instead of double-executing.
 * - Terminal states (`isTerminal: true`): `COMPLETED`, `PARTIALLY_COMPLETED`, `FAILED`.
 */

export interface SwapTermsWire {
  subaccountId?: string;
  sourceAssetId: number;
  destinationAssetId: number;
  amountE18: U128Json;
}

export interface QuoteSwapRequestWire {
  terms: SwapTermsWire;
  maxSlippageBps: number;
}

export interface SwapQuoteLegWire {
  symbolId?: number;
  side?: string;
  averagePrice?: string;
  priceImpactBps?: number;
  takerFeeRatePercent?: string;
  feeE18?: U128Json;
  feeAssetId?: number;
}

export interface QuoteSwapResponseWire {
  quote?: {
    terms?: SwapTermsWire;
    legs?: SwapQuoteLegWire[];
    expectedAmountOutE18?: U128Json;
    minAmountOutE18?: U128Json;
    quotedAt?: string;
    expiresAt?: string;
  };
}

export interface CreateSwapRequestWire {
  idempotencyKey: string;
  terms: SwapTermsWire;
  minAmountOutE18: U128Json;
  quoteExpiresAt: string;
}

export interface SwapWire {
  swapId?: string;
  idempotencyKey?: string;
  subaccountId?: string;
  sourceAssetId?: number;
  destinationAssetId?: number;
  amountE18?: U128Json;
  minAmountOutE18?: U128Json;
  status?: string;
  reason?: string;
  isTerminal?: boolean;
  executedAmountE18?: U128Json;
  unspentAmountE18?: U128Json;
  receivedAmountE18?: U128Json;
  feeE18?: U128Json;
  createdAt?: string;
}

export interface CreateSwapResponseWire {
  swap?: SwapWire;
}

export interface GetSwapRequestWire {
  swapId?: string;
  idempotencyKey?: string;
}

export interface GetSwapResponseWire {
  swap?: SwapWire;
}

export interface SingleLegSwapResult {
  swapId: string;
  idempotencyKey: string;
  status: string;
  reason?: string;
  isTerminal: boolean;
  requestedAmountE18: bigint;
  executedAmountE18: bigint;
  unspentAmountE18: bigint;
  receivedAmountE18: bigint;
  feeE18: bigint;
}

export interface RoundTripSwapOutcome {
  pair: string;
  dryRun: boolean;
  leg1?: SingleLegSwapResult;
  leg2?: SingleLegSwapResult;
  quotePreview?: {
    leg1ExpectedBase: string;
    leg1MinBase: string;
    leg1AvgPrice: string;
    leg1ImpactBps: number;
  };
  error?: string;
}

export async function quoteSwap(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
  sourceAssetId: number;
  destinationAssetId: number;
  amountE18: bigint;
  maxSlippageBps: number;
  subaccountId?: string;
  recvWindowMs?: number;
}): Promise<NonNullable<QuoteSwapResponseWire["quote"]>> {
  const terms: SwapTermsWire = {
    sourceAssetId: params.sourceAssetId,
    destinationAssetId: params.destinationAssetId,
    amountE18: toU128(params.amountE18),
    ...(params.subaccountId ? { subaccountId: params.subaccountId } : {}),
  };

  const res = await callConnectJsonWithApiKey<QuoteSwapRequestWire, QuoteSwapResponseWire>({
    apiUrl: params.apiUrl,
    procedurePath: "/swap.v1.SwapService/QuoteSwap",
    body: {
      terms,
      maxSlippageBps: params.maxSlippageBps,
    },
    apiKeyId: params.apiKeyId,
    apiPrivateKey: params.apiPrivateKey,
    recvWindowMs: params.recvWindowMs,
  });

  if (!res.quote || !res.quote.minAmountOutE18 || !res.quote.expiresAt) {
    throw new Error("QuoteSwap returned an incomplete quote response");
  }
  return res.quote;
}

export async function pollSwapUntilTerminal(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
  idempotencyKey: string;
  initialSwap?: SwapWire;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  recvWindowMs?: number;
}): Promise<SingleLegSwapResult> {
  const pollIntervalMs = params.pollIntervalMs ?? 1500;
  const maxPollAttempts = params.maxPollAttempts ?? 25;

  let current = params.initialSwap;
  let attempts = 0;

  while ((!current || !current.isTerminal) && attempts < maxPollAttempts) {
    if (attempts > 0 || !current) {
      await sleep(pollIntervalMs);
    }
    attempts++;

    const res = await callConnectJsonWithApiKey<GetSwapRequestWire, GetSwapResponseWire>({
      apiUrl: params.apiUrl,
      procedurePath: "/swap.v1.SwapService/GetSwap",
      body: { idempotencyKey: params.idempotencyKey },
      apiKeyId: params.apiKeyId,
      apiPrivateKey: params.apiPrivateKey,
      recvWindowMs: params.recvWindowMs,
    });
    if (res.swap) {
      current = res.swap;
    }
  }

  if (!current) {
    throw new Error(`GetSwap returned empty swap for idempotencyKey=${params.idempotencyKey}`);
  }

  return {
    swapId: String(current.swapId ?? ""),
    idempotencyKey: current.idempotencyKey ?? params.idempotencyKey,
    status: current.status ?? "UNKNOWN",
    reason:
      current.reason && current.reason !== "REASON_UNSPECIFIED" ? current.reason : undefined,
    isTerminal: Boolean(current.isTerminal),
    requestedAmountE18: fromU128(current.amountE18),
    executedAmountE18: fromU128(current.executedAmountE18),
    unspentAmountE18: fromU128(current.unspentAmountE18),
    receivedAmountE18: fromU128(current.receivedAmountE18),
    feeE18: fromU128(current.feeE18),
  };
}

/**
 * Quotes, creates, and polls one Swap leg (`sourceAssetId -> destinationAssetId`).
 * Automatically re-quotes once if the quote expired (`QUOTE_EXPIRED`) or book moved
 * (`PROTECTION_UNACHIEVABLE`) before `CreateSwap` was accepted.
 */
export async function executeSwapLeg(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
  sourceAssetId: number;
  destinationAssetId: number;
  sourceSymbol: string;
  destinationSymbol: string;
  amountE18: bigint;
  maxSlippageBps: number;
  subaccountId?: string;
  idempotencyKeyBase: string;
  recvWindowMs?: number;
}): Promise<SingleLegSwapResult> {
  const maxQuoteAttempts = 2;

  for (let qAttempt = 1; qAttempt <= maxQuoteAttempts; qAttempt++) {
    const idempotencyKey =
      qAttempt === 1
        ? params.idempotencyKeyBase
        : `${params.idempotencyKeyBase}-r${qAttempt}`;

    const quote = await quoteSwap({
      apiUrl: params.apiUrl,
      apiKeyId: params.apiKeyId,
      apiPrivateKey: params.apiPrivateKey,
      sourceAssetId: params.sourceAssetId,
      destinationAssetId: params.destinationAssetId,
      amountE18: params.amountE18,
      maxSlippageBps: params.maxSlippageBps,
      subaccountId: params.subaccountId,
      recvWindowMs: params.recvWindowMs,
    });

    const expectedOut = fromU128(quote.expectedAmountOutE18);
    const minOut = fromU128(quote.minAmountOutE18);
    const legInfo = quote.legs?.[0];

    logger.info(
      `Quoted ${params.sourceSymbol} -> ${params.destinationSymbol}`,
      {
        amountIn: `${fromE18(params.amountE18)} ${params.sourceSymbol}`,
        expectedOut: `${fromE18(expectedOut)} ${params.destinationSymbol}`,
        minOut: `${fromE18(minOut)} ${params.destinationSymbol}`,
        avgPrice: legInfo?.averagePrice,
        priceImpactBps: legInfo?.priceImpactBps ?? 0,
        expiresAt: quote.expiresAt,
      }
    );

    const terms: SwapTermsWire = {
      sourceAssetId: params.sourceAssetId,
      destinationAssetId: params.destinationAssetId,
      amountE18: toU128(params.amountE18),
      ...(params.subaccountId ? { subaccountId: params.subaccountId } : {}),
    };

    try {
      const created = await callConnectJsonWithApiKey<
        CreateSwapRequestWire,
        CreateSwapResponseWire
      >({
        apiUrl: params.apiUrl,
        procedurePath: "/swap.v1.SwapService/CreateSwap",
        body: {
          idempotencyKey,
          terms,
          minAmountOutE18: quote.minAmountOutE18!,
          quoteExpiresAt: quote.expiresAt!,
        },
        apiKeyId: params.apiKeyId,
        apiPrivateKey: params.apiPrivateKey,
        recvWindowMs: params.recvWindowMs,
      });

      const finalResult = await pollSwapUntilTerminal({
        apiUrl: params.apiUrl,
        apiKeyId: params.apiKeyId,
        apiPrivateKey: params.apiPrivateKey,
        idempotencyKey,
        initialSwap: created.swap,
        recvWindowMs: params.recvWindowMs,
      });

      logger.info(
        `Swap leg ${params.sourceSymbol} -> ${params.destinationSymbol} finished`,
        {
          swapId: finalResult.swapId,
          status: finalResult.status,
          reason: finalResult.reason,
          spent: `${fromE18(finalResult.executedAmountE18)} ${params.sourceSymbol}`,
          received: `${fromE18(finalResult.receivedAmountE18)} ${params.destinationSymbol}`,
          unspent: `${fromE18(finalResult.unspentAmountE18)} ${params.sourceSymbol}`,
          fee: `${fromE18(finalResult.feeE18)} ${params.destinationSymbol}`,
        }
      );

      return finalResult;
    } catch (err) {
      if (
        err instanceof ConnectRpcError &&
        (err.domainCode === "QUOTE_EXPIRED" ||
          err.domainCode === "PROTECTION_UNACHIEVABLE") &&
        qAttempt < maxQuoteAttempts
      ) {
        logger.warn(
          `CreateSwap rejected with ${err.domainCode}; refreshing quote (attempt ${qAttempt + 1}/${maxQuoteAttempts})...`
        );
        await sleep(500);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Exhausted quote attempts for ${params.sourceSymbol} -> ${params.destinationSymbol}`);
}

let cachedOrdersClientKey = "";
let cachedOrdersClient: PolyesterClient | null = null;

async function getReadyOrdersClient(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
}): Promise<PolyesterClient> {
  const key = `${params.apiUrl}|${params.apiKeyId}|${params.apiPrivateKey.slice(0, 8)}`;
  if (!cachedOrdersClient || cachedOrdersClientKey !== key) {
    cachedOrdersClient = new PolyesterClient({
      environment: buildEnvironment(params.apiUrl),
      auth: {
        kind: "api-key-ed25519",
        getKeyId: () => params.apiKeyId,
        getSecretKey: () => parseEd25519PrivateKey(params.apiPrivateKey),
      },
    });
    cachedOrdersClientKey = key;
  }
  await cachedOrdersClient.catalog.ensureReady();
  return cachedOrdersClient;
}

const TERMINAL_ORDER_STATUSES = new Set(["filled", "canceled", "rejected"]);

async function pollSpotOrderUntilTerminal(
  client: PolyesterClient,
  orderId: string,
  subaccountId?: string
) {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (attempt > 0) {
      await sleep(800);
    }
    const details = await client.orders.getDetails({
      orderId,
      includeExecutionHistory: false,
      ...(subaccountId ? { account: { subaccountId } } : {}),
    });
    if (details?.order && TERMINAL_ORDER_STATUSES.has(details.order.status)) {
      return details.order;
    }
  }
  const last = await client.orders.getDetails({
    orderId,
    includeExecutionHistory: false,
    ...(subaccountId ? { account: { subaccountId } } : {}),
  });
  if (!last?.order) {
    throw new Error(`Order ${orderId} not found when polling terminal state`);
  }
  return last.order;
}

function quantizeDownToStepE18(amountE18: bigint, stepE18: bigint): bigint {
  if (stepE18 <= 0n) return amountE18;
  return (amountE18 / stepE18) * stepE18;
}

/**
 * Fallback round-trip execution via Spot `OrdersService` Market IOC (`BUY` -> `SELL`)
 * when an API key has `trade-spot` permission rather than `swap` (`SWAP_NOT_PERMITTED`).
 */
export async function executeRoundTripSpotMarketOrdersForPair(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
  pair: TrendingPairCandidate;
  swapAmountQuote: string;
  maxSlippageBps: number;
  subaccountId?: string;
  cycleId: string;
  dryRun?: boolean;
  interLegDelayMs?: number;
}): Promise<RoundTripSwapOutcome> {
  const { pair, dryRun = false } = params;
  const amountInE18 = toE18(params.swapAmountQuote);
  const safeSymbol = pair.symbol.replace(/[^A-Za-z0-9._:-]/g, "-");
  const client = await getReadyOrdersClient(params);
  const accountScope = params.subaccountId
    ? { account: { subaccountId: params.subaccountId } }
    : {};

  // Preview Leg 1 with feeAsset="quote" first; fallback to "base" if needed
  let buyFeeAsset: "quote" | "base" = "quote";
  let preview = await client.orders.preview({
    symbolId: pair.symbolId,
    side: "buy",
    maxQuoteDebit: params.swapAmountQuote,
    feeAsset: buyFeeAsset,
    execution: {
      type: "market_ioc",
      maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
    },
    ...accountScope,
  });

  if (!preview.admissible && preview.rejection?.code === "FEE_ASSET_NOT_ALLOWED") {
    buyFeeAsset = "base";
    preview = await client.orders.preview({
      symbolId: pair.symbolId,
      side: "buy",
      maxQuoteDebit: params.swapAmountQuote,
      feeAsset: buyFeeAsset,
      execution: {
        type: "market_ioc",
        maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
      },
      ...accountScope,
    });
  }

  if (!preview.admissible) {
    throw new Error(
      `Market IOC buy preview rejected on ${pair.symbol}: ${preview.rejection?.code ?? "REJECTED"}`
    );
  }

  const expectedBase = preview.resolvedBaseQty ?? "0";
  if (dryRun) {
    logger.info(`[DRY RUN] Previewed Market IOC Leg 1 for ${pair.symbol}`, {
      spend: `${params.swapAmountQuote} ${pair.quoteAsset}`,
      expectedReceive: `${expectedBase} ${pair.baseAsset}`,
      protectedPriceBound: preview.protectedPriceBound ?? pair.lastPrice,
    });
    return {
      pair: pair.symbol,
      dryRun: true,
      quotePreview: {
        leg1ExpectedBase: expectedBase,
        leg1MinBase: expectedBase,
        leg1AvgPrice: preview.protectedPriceBound ?? pair.lastPrice,
        leg1ImpactBps: 0,
      },
    };
  }

  // Leg 1: BUY Market IOC
  const leg1Key = `mm-${params.cycleId}-${safeSymbol}-leg1`.slice(0, 64);
  const leg1Created = await client.orders.create({
    symbolId: pair.symbolId,
    side: "buy",
    maxQuoteDebit: params.swapAmountQuote,
    feeAsset: buyFeeAsset,
    execution: {
      type: "market_ioc",
      maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
    },
    clientOrderId: leg1Key,
    ...accountScope,
  });

  const leg1Order = await pollSpotOrderUntilTerminal(
    client,
    leg1Created.orderId,
    params.subaccountId
  );

  const leg1CumQuoteE18 = toE18(leg1Order.cumQuote || "0");
  const leg1CumQtyE18 = toE18(leg1Order.cumQty || "0");
  const leg1FeeE18 = leg1Order.feeTotal?.amount ? toE18(leg1Order.feeTotal.amount) : 0n;
  const leg1BaseFeeE18 =
    leg1Order.feeAsset === "base" &&
    leg1Order.feeTotal?.qty &&
    !leg1Order.feeTotal.isRebate
      ? toE18(leg1Order.feeTotal.qty)
      : 0n;

  const netBaseReceivedE18 =
    leg1CumQtyE18 > leg1BaseFeeE18 ? leg1CumQtyE18 - leg1BaseFeeE18 : 0n;

  const leg1Result: SingleLegSwapResult = {
    swapId: leg1Order.orderId,
    idempotencyKey: leg1Key,
    status: leg1Order.status.toUpperCase(),
    reason: leg1Order.rejectReason ?? leg1Order.cancelReason,
    isTerminal: TERMINAL_ORDER_STATUSES.has(leg1Order.status),
    requestedAmountE18: amountInE18,
    executedAmountE18: leg1CumQuoteE18,
    unspentAmountE18: amountInE18 > leg1CumQuoteE18 ? amountInE18 - leg1CumQuoteE18 : 0n,
    receivedAmountE18: netBaseReceivedE18,
    feeE18: leg1FeeE18,
  };

  logger.info(`Spot Market IOC Leg 1 (${pair.quoteAsset} -> ${pair.baseAsset}) finished`, {
    orderId: leg1Result.swapId,
    status: leg1Result.status,
    spent: `${fromE18(leg1Result.executedAmountE18)} ${pair.quoteAsset}`,
    received: `${fromE18(leg1Result.receivedAmountE18)} ${pair.baseAsset}`,
    fee: `${fromE18(leg1Result.feeE18)} ${leg1Order.feeAsset === "base" ? pair.baseAsset : pair.quoteAsset}`,
  });

  if (netBaseReceivedE18 <= 0n) {
    return {
      pair: pair.symbol,
      dryRun: false,
      leg1: leg1Result,
      error: `Leg 1 (${pair.quoteAsset}->${pair.baseAsset}) filled 0 ${pair.baseAsset} (status=${leg1Result.status}, reason=${leg1Result.reason ?? "none"})`,
    };
  }

  await sleep(params.interLegDelayMs ?? 1500);

  // Quantize netBaseReceivedE18 down to the pair's base quantity step size
  const catalogPair = client.catalog.market
    .listPairs()
    .find((p) => p.symbolId === pair.symbolId);
  const qtyStepE18 = catalogPair?.stepSize ? toE18(catalogPair.stepSize) : 0n;
  const sellQtyE18 = quantizeDownToStepE18(netBaseReceivedE18, qtyStepE18);
  const sellQtyStr = fromE18(sellQtyE18);

  if (sellQtyE18 <= 0n) {
    return {
      pair: pair.symbol,
      dryRun: false,
      leg1: leg1Result,
      error: `Received base qty ${fromE18(netBaseReceivedE18)} is smaller than step size ${catalogPair?.stepSize ?? "0"}`,
    };
  }

  // Leg 2: SELL Market IOC
  const leg2Key = `mm-${params.cycleId}-${safeSymbol}-leg2`.slice(0, 64);
  const leg2Created = await client.orders.create({
    symbolId: pair.symbolId,
    side: "sell",
    qty: sellQtyStr,
    feeAsset: "quote",
    execution: {
      type: "market_ioc",
      maxSlippage: { kind: "bps", bps: params.maxSlippageBps },
    },
    clientOrderId: leg2Key,
    ...accountScope,
  });

  const leg2Order = await pollSpotOrderUntilTerminal(
    client,
    leg2Created.orderId,
    params.subaccountId
  );

  const leg2CumQtyE18 = toE18(leg2Order.cumQty || "0");
  const leg2CumQuoteE18 = toE18(leg2Order.cumQuote || "0");
  const leg2FeeE18 = leg2Order.feeTotal?.amount ? toE18(leg2Order.feeTotal.amount) : 0n;
  const netQuoteReturnedE18 =
    leg2Order.feeTotal && !leg2Order.feeTotal.isRebate && leg2CumQuoteE18 > leg2FeeE18
      ? leg2CumQuoteE18 - leg2FeeE18
      : leg2CumQuoteE18;

  const leg2Result: SingleLegSwapResult = {
    swapId: leg2Order.orderId,
    idempotencyKey: leg2Key,
    status: leg2Order.status.toUpperCase(),
    reason: leg2Order.rejectReason ?? leg2Order.cancelReason,
    isTerminal: TERMINAL_ORDER_STATUSES.has(leg2Order.status),
    requestedAmountE18: sellQtyE18,
    executedAmountE18: leg2CumQtyE18,
    unspentAmountE18: sellQtyE18 > leg2CumQtyE18 ? sellQtyE18 - leg2CumQtyE18 : 0n,
    receivedAmountE18: netQuoteReturnedE18,
    feeE18: leg2FeeE18,
  };

  logger.info(`Spot Market IOC Leg 2 (${pair.baseAsset} -> ${pair.quoteAsset}) finished`, {
    orderId: leg2Result.swapId,
    status: leg2Result.status,
    sold: `${fromE18(leg2Result.executedAmountE18)} ${pair.baseAsset}`,
    received: `${fromE18(leg2Result.receivedAmountE18)} ${pair.quoteAsset}`,
    fee: `${fromE18(leg2Result.feeE18)} ${pair.quoteAsset}`,
  });

  return {
    pair: pair.symbol,
    dryRun: false,
    leg1: leg1Result,
    leg2: leg2Result,
  };
}

function isSwapNotPermittedError(err: unknown): boolean {
  if (!(err instanceof ConnectRpcError)) return false;
  return (
    err.domainCode === "SWAP_NOT_PERMITTED" ||
    err.message.includes("SWAP_NOT_PERMITTED") ||
    err.message.includes("may not Swap")
  );
}

/**
 * Executes a full round-trip Swap on a trending pair:
 *   Leg 1: `quoteAsset (USDT) -> baseAsset` using `swapAmountQuote`
 *   Leg 2: `baseAsset -> quoteAsset (USDT)` using exact `leg1.receivedAmountE18`
 *
 * In `dryRun` mode, requests a live `QuoteSwap` for Leg 1 without calling `CreateSwap`.
 * If the API key policy has `trade-spot` permission rather than `swap` (`SWAP_NOT_PERMITTED`),
 * automatically executes the round-trip via Spot `OrdersService` Market IOC orders.
 */
export async function executeRoundTripSwapForPair(params: {
  apiUrl: string;
  apiKeyId: string;
  apiPrivateKey: string;
  pair: TrendingPairCandidate;
  swapAmountQuote: string;
  maxSlippageBps: number;
  subaccountId?: string;
  cycleId: string;
  dryRun?: boolean;
  interLegDelayMs?: number;
  recvWindowMs?: number;
}): Promise<RoundTripSwapOutcome> {
  const { pair, dryRun = false } = params;
  const amountInE18 = toE18(params.swapAmountQuote);
  const safeSymbol = pair.symbol.replace(/[^A-Za-z0-9._:-]/g, "-");

  try {
    if (dryRun) {
      const quote = await quoteSwap({
        apiUrl: params.apiUrl,
        apiKeyId: params.apiKeyId,
        apiPrivateKey: params.apiPrivateKey,
        sourceAssetId: pair.quoteAssetId,
        destinationAssetId: pair.baseAssetId,
        amountE18: amountInE18,
        maxSlippageBps: params.maxSlippageBps,
        subaccountId: params.subaccountId,
        recvWindowMs: params.recvWindowMs,
      });

      const expectedBase = fromE18(fromU128(quote.expectedAmountOutE18));
      const minBase = fromE18(fromU128(quote.minAmountOutE18));
      const legInfo = quote.legs?.[0];

      logger.info(`[DRY RUN] Quoted Leg 1 for ${pair.symbol}`, {
        spend: `${params.swapAmountQuote} ${pair.quoteAsset}`,
        expectedReceive: `${expectedBase} ${pair.baseAsset}`,
        minReceive: `${minBase} ${pair.baseAsset}`,
        avgPrice: legInfo?.averagePrice ?? pair.lastPrice,
        priceImpactBps: legInfo?.priceImpactBps ?? 0,
      });

      return {
        pair: pair.symbol,
        dryRun: true,
        quotePreview: {
          leg1ExpectedBase: expectedBase,
          leg1MinBase: minBase,
          leg1AvgPrice: legInfo?.averagePrice ?? pair.lastPrice,
          leg1ImpactBps: legInfo?.priceImpactBps ?? 0,
        },
      };
    }

    // Leg 1: QUOTE (USDT) -> BASE
    const leg1Key = `mm-${params.cycleId}-${safeSymbol}-leg1`.slice(0, 120);
    const leg1 = await executeSwapLeg({
      apiUrl: params.apiUrl,
      apiKeyId: params.apiKeyId,
      apiPrivateKey: params.apiPrivateKey,
      sourceAssetId: pair.quoteAssetId,
      destinationAssetId: pair.baseAssetId,
      sourceSymbol: pair.quoteAsset,
      destinationSymbol: pair.baseAsset,
      amountE18: amountInE18,
      maxSlippageBps: params.maxSlippageBps,
      subaccountId: params.subaccountId,
      idempotencyKeyBase: leg1Key,
      recvWindowMs: params.recvWindowMs,
    });

    // Note: Per docs, even a FAILED swap with MINIMUM_NOT_MET or PARTIALLY_COMPLETED
    // can have settled fills reflected in `receivedAmountE18`. If we received > 0 base asset,
    // we swap it back to keep inventory flat.
    if (leg1.receivedAmountE18 <= 0n) {
      return {
        pair: pair.symbol,
        dryRun: false,
        leg1,
        error: `Leg 1 (${pair.quoteAsset}->${pair.baseAsset}) produced 0 ${pair.baseAsset} (status=${leg1.status}, reason=${leg1.reason ?? "none"})`,
      };
    }

    await sleep(params.interLegDelayMs ?? 1500);

    // Leg 2: BASE -> QUOTE (USDT) with the exact received base amount
    const leg2Key = `mm-${params.cycleId}-${safeSymbol}-leg2`.slice(0, 120);
    const leg2 = await executeSwapLeg({
      apiUrl: params.apiUrl,
      apiKeyId: params.apiKeyId,
      apiPrivateKey: params.apiPrivateKey,
      sourceAssetId: pair.baseAssetId,
      destinationAssetId: pair.quoteAssetId,
      sourceSymbol: pair.baseAsset,
      destinationSymbol: pair.quoteAsset,
      amountE18: leg1.receivedAmountE18,
      maxSlippageBps: params.maxSlippageBps,
      subaccountId: params.subaccountId,
      idempotencyKeyBase: leg2Key,
      recvWindowMs: params.recvWindowMs,
    });

    return {
      pair: pair.symbol,
      dryRun: false,
      leg1,
      leg2,
    };
  } catch (err) {
    if (isSwapNotPermittedError(err)) {
      logger.info(
        `API key uses Spot Trading policy (SWAP_NOT_PERMITTED on SwapService); executing round-trip via Spot Market IOC orders for ${pair.symbol}...`
      );
      try {
        return await executeRoundTripSpotMarketOrdersForPair(params);
      } catch (fallbackErr) {
        const fbMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        logger.error(`Round-trip spot market order failed on ${pair.symbol}: ${fbMsg}`);
        return {
          pair: pair.symbol,
          dryRun,
          error: fbMsg,
        };
      }
    }

    let errMsg = err instanceof Error ? err.message : String(err);
    if (err instanceof ConnectRpcError && err.swapDetail) {
      const minStr =
        err.swapDetail.minAmountE18 !== undefined
          ? ` min=${fromE18(err.swapDetail.minAmountE18)}`
          : "";
      const maxStr =
        err.swapDetail.maxAmountE18 !== undefined
          ? ` max=${fromE18(err.swapDetail.maxAmountE18)}`
          : "";
      errMsg = `${err.message}${minStr}${maxStr}`;
    }

    logger.error(`Round-trip swap failed on ${pair.symbol}: ${errMsg}`);
    return {
      pair: pair.symbol,
      dryRun,
      error: errMsg,
    };
  }
}
