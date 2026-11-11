import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toE18 } from "../src/lib/u128.js";
import { computeTwoSidedQuotes } from "../src/services/marketMaker.js";

describe("Two-Sided Limit Market Maker quote math", () => {
  it("computes Bid and Ask around L2 mid-price aligned to tickSize and stepSize", () => {
    const quotes = computeTwoSidedQuotes({
      bestBidE18: toE18("74400.00"),
      bestAskE18: toE18("74420.00"),
      fallbackLastPriceE18: toE18("74410.00"),
      tickSizeE18: toE18("0.01"),
      stepSizeE18: toE18("0.00001"),
      minQtyE18: toE18("0.0001"),
      minNotionalE18: toE18("5"),
      orderNotionalE18: toE18("80"),
      halfSpreadBps: 15,
    });

    assert.equal(quotes.midPriceE18, toE18("74410"));
    assert.ok(quotes.bidPriceE18 < toE18("74400.00"), "Bid must be strictly below bestAsk and mid");
    assert.ok(quotes.askPriceE18 > toE18("74420.00"), "Ask must be strictly above bestBid and mid");
    assert.equal(quotes.bidPriceStr, "74298.38");
    assert.equal(quotes.askPriceStr, "74521.62");
    assert.equal(quotes.qtyStr, "0.00107");
  });

  it("clamps Post-Only Bid below bestAsk and Ask above bestBid when halfSpreadBps is tight", () => {
    const quotes = computeTwoSidedQuotes({
      bestBidE18: toE18("100.00"),
      bestAskE18: toE18("100.01"),
      fallbackLastPriceE18: toE18("100.00"),
      tickSizeE18: toE18("0.01"),
      stepSizeE18: toE18("0.01"),
      minQtyE18: toE18("0.1"),
      minNotionalE18: toE18("10"),
      orderNotionalE18: toE18("50"),
      halfSpreadBps: 1,
    });

    assert.ok(quotes.bidPriceE18 < toE18("100.01"));
    assert.ok(quotes.askPriceE18 > toE18("100.00"));
    assert.ok(quotes.askPriceE18 > quotes.bidPriceE18);
  });
});
