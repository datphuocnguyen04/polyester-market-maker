import {
  PolyesterClient,
  type MarketOverview,
  type PairStatus,
} from "@polyester/sdk";
import { logger } from "../lib/logger.js";
import { toE18 } from "../lib/u128.js";
import { buildEnvironment } from "./session.js";

/**
 * Fetches and selects the top N trending spot pairs by 24h USD volume
 * (`volume_24h_usd` descending) that are eligible for round-trip Swaps:
 * - Quoted in `quoteAsset` (default: "USDT")
 * - Pair status is `"enabled"`
 * - `allowBuyFeeFromBase === true` (SwapService buy requirement: "A buy is
 *   supported only when the market can charge its fee in the Asset received")
 * - Has a positive valued `volume24hUsd`
 * - `minNotionalQuote <= swapAmountQuote`
 */

export interface PairMetadataForTrending {
  symbolId: number;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetId: number;
  quoteAssetId: number;
  status: PairStatus;
  minNotionalQuote: string;
  allowBuyFeeFromBase: boolean;
}

export interface TrendingPairCandidate extends PairMetadataForTrending {
  lastPrice: string;
  change24hBps: number;
  volume24hUsd: string;
}

const EXCLUDED_BASE_ASSETS = new Set(["USDC"]);

/**
 * Pure filtering and ranking function (also used by unit tests).
 */
export function selectTrendingPairs(params: {
  overviewRows: Pick<
    MarketOverview,
    "symbolId" | "lastPrice" | "change24hBps" | "volume24hUsd"
  >[];
  pairBySymbolId: ReadonlyMap<number, PairMetadataForTrending>;
  quoteAsset: string;
  swapAmountQuote: string;
  limit: number;
  requireBuyFeeFromBase?: boolean;
}): { selected: TrendingPairCandidate[]; skippedReasons: Record<string, string> } {
  const targetQuote = params.quoteAsset.toUpperCase();
  const swapAmountE18 = toE18(params.swapAmountQuote);
  const skippedReasons: Record<string, string> = {};
  const eligible: { item: TrendingPairCandidate; volumeE18: bigint }[] = [];

  for (const row of params.overviewRows) {
    const meta = params.pairBySymbolId.get(row.symbolId);
    if (!meta) {
      skippedReasons[`symbolId:${row.symbolId}`] = "unknown_catalog_symbol";
      continue;
    }

    if (meta.quoteAsset.toUpperCase() !== targetQuote) {
      skippedReasons[meta.symbol] = `quote_asset_mismatch (${meta.quoteAsset})`;
      continue;
    }

    if (EXCLUDED_BASE_ASSETS.has(meta.baseAsset.toUpperCase())) {
      skippedReasons[meta.symbol] = `excluded_base_asset (${meta.baseAsset})`;
      continue;
    }

    if (meta.status !== "enabled") {
      skippedReasons[meta.symbol] = `pair_status_${meta.status}`;
      continue;
    }

    if (params.requireBuyFeeFromBase && !meta.allowBuyFeeFromBase) {
      skippedReasons[meta.symbol] = "buy_fee_from_base_not_allowed";
      continue;
    }

    if (!row.volume24hUsd) {
      skippedReasons[meta.symbol] = "unvalued_volume_24h_usd";
      continue;
    }

    let volumeE18 = 0n;
    try {
      volumeE18 = toE18(row.volume24hUsd);
    } catch {
      skippedReasons[meta.symbol] = `invalid_volume_24h_usd (${row.volume24hUsd})`;
      continue;
    }

    if (volumeE18 <= 0n) {
      skippedReasons[meta.symbol] = "zero_volume_24h_usd";
      continue;
    }

    let minNotionalE18 = 0n;
    try {
      minNotionalE18 = toE18(meta.minNotionalQuote);
    } catch {
      minNotionalE18 = 0n;
    }

    if (swapAmountE18 < minNotionalE18) {
      skippedReasons[meta.symbol] = `swap_amount_below_min_notional (min=${meta.minNotionalQuote} ${meta.quoteAsset})`;
      continue;
    }

    eligible.push({
      item: {
        ...meta,
        lastPrice: row.lastPrice,
        change24hBps: row.change24hBps,
        volume24hUsd: row.volume24hUsd,
      },
      volumeE18,
    });
  }

  // Ensure deterministic descending order by 24h USD volume
  eligible.sort((a, b) => {
    if (a.volumeE18 !== b.volumeE18) {
      return a.volumeE18 > b.volumeE18 ? -1 : 1;
    }
    return a.item.symbolId - b.item.symbolId;
  });

  return {
    selected: eligible.slice(0, params.limit).map((e) => e.item),
    skippedReasons,
  };
}

/**
 * Fetches live MarketOverview rows + Spot Catalog from Polyester Testnet
 * and returns the top `trendingCount` eligible trending pairs.
 */
export async function fetchTrendingPairs(params: {
  apiUrl?: string;
  quoteAsset: string;
  swapAmountQuote: string;
  trendingCount: number;
}): Promise<TrendingPairCandidate[]> {
  const environment = buildEnvironment(params.apiUrl);
  const client = new PolyesterClient({ environment });

  logger.info("Fetching spot catalog and 24h market overview...");
  let markets: MarketOverview[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await client.catalog.ensureReady();
      const res = await client.marketOverview.list({
        limit: 200,
        orderBy: "volume_24h_usd",
        sort: "desc",
        includeSparklines: false,
      });
      markets = res.markets;
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      logger.warn(
        `Market overview retry ${attempt}/5 after transient API error: ${err instanceof Error ? err.message : String(err)}`
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  const pairMap = new Map<number, PairMetadataForTrending>();
  for (const pair of client.catalog.market.listPairs()) {
    pairMap.set(pair.symbolId, {
      symbolId: pair.symbolId,
      symbol: pair.symbol,
      baseAsset: pair.baseAsset.symbol,
      quoteAsset: pair.quoteAsset.symbol,
      baseAssetId: pair.baseAsset.ledgerId,
      quoteAssetId: pair.quoteAsset.ledgerId,
      status: pair.status,
      minNotionalQuote: pair.minNotionalQuote,
      allowBuyFeeFromBase: pair.allowBuyFeeFromBase,
    });
  }

  const { selected, skippedReasons } = selectTrendingPairs({
    overviewRows: markets,
    pairBySymbolId: pairMap,
    quoteAsset: params.quoteAsset,
    swapAmountQuote: params.swapAmountQuote,
    limit: params.trendingCount,
  });

  logger.info(`Selected ${selected.length}/${params.trendingCount} trending ${params.quoteAsset} pairs`, {
    pairs: selected.map(
      (p, idx) =>
        `#${idx + 1} ${p.symbol} (vol24h=$${p.volume24hUsd}, last=${p.lastPrice}, chg=${(p.change24hBps / 100).toFixed(2)}%)`
    ),
  });
  logger.debug("Skipped pairs summary", skippedReasons);

  return selected;
}
