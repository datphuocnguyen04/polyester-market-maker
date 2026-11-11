import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromE18, fromU128, toE18, toU128 } from "../src/lib/u128.js";

describe("u128 and e18 decimal conversions", () => {
  it("converts whole and fractional decimal strings to e18 bigint accurately", () => {
    assert.equal(toE18("0"), 0n);
    assert.equal(toE18("1"), 1_000_000_000_000_000_000n);
    assert.equal(toE18("10.5"), 10_500_000_000_000_000_000n);
    assert.equal(toE18("0.000000000000000001"), 1n);
    assert.equal(toE18("18.446744073709551617"), 18_446_744_073_709_551_617n);
  });

  it("formats e18 bigints back to normalized decimal strings", () => {
    assert.equal(fromE18(0n), "0");
    assert.equal(fromE18(1_000_000_000_000_000_000n), "1");
    assert.equal(fromE18(10_500_000_000_000_000_000n), "10.5");
    assert.equal(fromE18(1n), "0.000000000000000001");
    assert.equal(fromE18(18_446_744_073_709_551_617n), "18.446744073709551617");
  });

  it("round-trips values below and above 2^64 through U128 { hi, lo }", () => {
    // Below 2^64 (10 USDT = 10 * 10^18 < 18.4467 * 10^18)
    const tenE18 = toE18("10");
    const u10 = toU128(tenE18);
    assert.equal(u10.hi, "0");
    assert.equal(u10.lo, "10000000000000000000");
    assert.equal(fromU128(u10), tenE18);

    // Above 2^64 (e.g. 18.446744073709551617 * 10^18 = 2^64 + 1)
    const above64 = (1n << 64n) + 1n;
    const uAbove = toU128(above64);
    assert.equal(uAbove.hi, "1");
    assert.equal(uAbove.lo, "1");
    assert.equal(fromU128(uAbove), above64);

    // Large value (1,000,000 USDT in e18)
    const millionE18 = toE18("1000000.123456789");
    const uMillion = toU128(millionE18);
    assert.notEqual(uMillion.hi, "0");
    assert.equal(fromU128(uMillion), millionE18);
    assert.equal(fromE18(fromU128(uMillion)), "1000000.123456789");
  });

  it("rejects negative or excessive-precision inputs", () => {
    assert.throws(() => toE18("-1"));
    assert.throws(() => toE18("1.0000000000000000001")); // 19 decimals
    assert.throws(() => toE18("abc"));
  });
});
