import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  buildCanonicalString,
  normalizeQuery,
  sha256Hex,
  signApiKeyRequest,
} from "../src/lib/apiKeySigner.js";

describe("Ed25519 API key request signing", () => {
  it("normalizes query strings exactly as specified in the Polyester docs", () => {
    // Exact example from https://testnet.polyester.com/docs/developer-docs/authentication-security/ed25519-api-keys
    const raw = "tag=z&q=hello+world&literal=%2B&tag=a&empty=";
    const expected = "empty=&literal=%2B&q=hello%20world&tag=a&tag=z";
    assert.equal(normalizeQuery(raw), expected);
    assert.equal(normalizeQuery(`?${raw}`), expected);
    assert.equal(normalizeQuery(""), "");
  });

  it("hashes an empty body to the documented SHA-256 constant", () => {
    assert.equal(
      sha256Hex(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("builds the 5-line canonical string and produces a verifiable 128-hex Ed25519 signature", () => {
    const privKeyBytes = ed25519.utils.randomPrivateKey();
    const pubKeyBytes = ed25519.getPublicKey(privKeyBytes);
    const privKeyHex = Buffer.from(privKeyBytes).toString("hex");

    const body = JSON.stringify({
      maxSlippageBps: 50,
      terms: {
        sourceAssetId: 1,
        destinationAssetId: 2,
        amountE18: { hi: "0", lo: "10000000000000000000" },
      },
    });

    const timestampMs = "1736000000000";
    const path = "/swap.v1.SwapService/QuoteSwap";

    const headers = signApiKeyRequest({
      apiKeyId: "ak_test123",
      privateKeyHex: privKeyHex,
      method: "POST",
      path,
      rawQuery: "",
      body,
      timestampMs,
    });

    assert.equal(headers["X-API-KEY-ID"], "ak_test123");
    assert.equal(headers["X-API-TIMESTAMP"], timestampMs);
    assert.equal(headers["X-API-SIGNATURE"].length, 128);

    const canonical = buildCanonicalString({
      timestampMs,
      method: "POST",
      path,
      rawQuery: "",
      body,
    });

    const sigBytes = Uint8Array.from(Buffer.from(headers["X-API-SIGNATURE"], "hex"));
    const msgBytes = new TextEncoder().encode(canonical);
    assert.equal(ed25519.verify(sigBytes, msgBytes, pubKeyBytes), true);
  });
});
