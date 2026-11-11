import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  selectTrendingPairs,
  type PairMetadataForTrending,
} from "../src/services/trending.js";

describe("Trending pairs filtering and ranking", () => {
  it("selects top N active USDT pairs with allowBuyFeeFromBase and sufficient minNotional", () => {
    const pairCatalog = new Map<number, PairMetadataForTrending>([
      [
        1,
        {
          symbolId: 1,
          symbol: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          baseAssetId: 10,
          quoteAssetId: 100,
          status: "enabled",
          minNotionalQuote: "5",
          allowBuyFeeFromBase: true,
        },
      ],
      [
        2,
        {
          symbolId: 2,
          symbol: "ETH-USDT",
          baseAsset: "ETH",
          quoteAsset: "USDT",
          baseAssetId: 11,
          quoteAssetId: 100,
          status: "enabled",
          minNotionalQuote: "5",
          allowBuyFeeFromBase: true,
        },
      ],
      [
        3,
        {
          symbolId: 3,
          symbol: "SOL-USDC", // wrong quote asset
          baseAsset: "SOL",
          quoteAsset: "USDC",
          baseAssetId: 12,
          quoteAssetId: 101,
          status: "enabled",
          minNotionalQuote: "1",
          allowBuyFeeFromBase: true,
        },
      ],
      [
        4,
        {
          symbolId: 4,
          symbol: "HALT-USDT", // halted
          baseAsset: "HALT",
          quoteAsset: "USDT",
          baseAssetId: 13,
          quoteAssetId: 100,
          status: "halted",
          minNotionalQuote: "1",
          allowBuyFeeFromBase: true,
        },
      ],
      [
        5,
        {
          symbolId: 5,
          symbol: "WHALE-USDT", // minNotional > 10 USDT
          baseAsset: "WHALE",
          quoteAsset: "USDT",
          baseAssetId: 14,
          quoteAssetId: 100,
          status: "enabled",
          minNotionalQuote: "25",
          allowBuyFeeFromBase: true,
        },
      ],
      [
        6,
        {
          symbolId: 6,
          symbol: "HYPE-USDT",
          baseAsset: "HYPE",
          quoteAsset: "USDT",
          baseAssetId: 15,
          quoteAssetId: 100,
          status: "enabled",
          minNotionalQuote: "1",
          allowBuyFeeFromBase: true,
        },
      ],
    ]);

    const overviewRows = [
      { symbolId: 2, lastPrice: "3000", change24hBps: 250, volume24hUsd: "500000" },
      { symbolId: 1, lastPrice: "65000", change24hBps: 120, volume24hUsd: "1200000" },
      { symbolId: 3, lastPrice: "150", change24hBps: 500, volume24hUsd: "900000" },
      { symbolId: 4, lastPrice: "1", change24hBps: 0, volume24hUsd: "800000" },
      { symbolId: 5, lastPrice: "100", change24hBps: 50, volume24hUsd: "700000" },
      { symbolId: 6, lastPrice: "25", change24hBps: 800, volume24hUsd: "300000" },
    ];

    const { selected, skippedReasons } = selectTrendingPairs({
      overviewRows,
      pairBySymbolId: pairCatalog,
      quoteAsset: "USDT",
      swapAmountQuote: "10",
      limit: 5,
    });

    assert.deepEqual(
      selected.map((p) => p.symbol),
      ["BTC-USDT", "ETH-USDT", "HYPE-USDT"]
    );
    assert.match(skippedReasons["SOL-USDC"] ?? "", /quote_asset_mismatch/);
    assert.match(skippedReasons["HALT-USDT"] ?? "", /pair_status_halted/);
    assert.match(skippedReasons["WHALE-USDT"] ?? "", /swap_amount_below_min_notional/);
  });
});
