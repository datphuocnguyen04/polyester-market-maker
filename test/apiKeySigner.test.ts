import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  buildCanonicalString,
  normalizeQuery,
  sha256Hex,
  signApiKeyRequest,
  validateRecvWindowMs,
} from "../src/lib/apiKeySigner.js";
import { ConnectRpcError, isRetryableConnectError } from "../src/lib/connect.js";

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

  it("builds the standard 5-line canonical string and produces a verifiable signature when recvWindowMs is omitted", () => {
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

    const canonical = buildCanonicalString({
      timestampMs,
      method: "POST",
      path,
      rawQuery: "",
      body,
    });

    const lines = canonical.split("\n");
    assert.equal(lines.length, 5);
    assert.equal(lines[0], timestampMs);
    assert.equal(lines[1], "POST");
    assert.equal(lines[2], path);
    assert.equal(lines[3], "");
    assert.equal(lines[4], sha256Hex(body));

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
    assert.equal(headers["X-API-RECV-WINDOW"], undefined);

    const sigBytes = Uint8Array.from(Buffer.from(headers["X-API-SIGNATURE"], "hex"));
    const msgBytes = new TextEncoder().encode(canonical);
    assert.equal(ed25519.verify(sigBytes, msgBytes, pubKeyBytes), true);
  });

  it("builds the 6-line canonical string and sets X-API-RECV-WINDOW header when recvWindowMs is provided", () => {
    const privKeyBytes = ed25519.utils.randomPrivateKey();
    const pubKeyBytes = ed25519.getPublicKey(privKeyBytes);
    const privKeyHex = Buffer.from(privKeyBytes).toString("hex");

    const body = JSON.stringify({ foo: "bar" });
    const timestampMs = "1736000050000";
    const recvWindowMs = 5000;
    const path = "/swap.v1.SwapService/CreateSwap";
    const rawQuery = "tag=test";

    const canonical = buildCanonicalString({
      timestampMs,
      method: "post",
      path,
      rawQuery,
      body,
      recvWindowMs,
    });

    const lines = canonical.split("\n");
    assert.equal(lines.length, 6);
    assert.equal(lines[0], timestampMs);
    assert.equal(lines[1], "5000");
    assert.equal(lines[2], "POST");
    assert.equal(lines[3], path);
    assert.equal(lines[4], "tag=test");
    assert.equal(lines[5], sha256Hex(body));

    const headers = signApiKeyRequest({
      apiKeyId: "ak_recv_window_test",
      privateKeyHex: privKeyHex,
      method: "post",
      path,
      rawQuery,
      body,
      timestampMs,
      recvWindowMs,
    });

    assert.equal(headers["X-API-KEY-ID"], "ak_recv_window_test");
    assert.equal(headers["X-API-TIMESTAMP"], timestampMs);
    assert.equal(headers["X-API-RECV-WINDOW"], "5000");
    assert.equal(headers["X-API-SIGNATURE"].length, 128);

    const sigBytes = Uint8Array.from(Buffer.from(headers["X-API-SIGNATURE"], "hex"));
    const msgBytes = new TextEncoder().encode(canonical);
    assert.equal(ed25519.verify(sigBytes, msgBytes, pubKeyBytes), true);
  });

  it("validates recvWindowMs boundaries (1..60000 integer)", () => {
    assert.doesNotThrow(() => validateRecvWindowMs(1));
    assert.doesNotThrow(() => validateRecvWindowMs(60000));
    assert.doesNotThrow(() => validateRecvWindowMs(5000));

    assert.throws(() => validateRecvWindowMs(0), /Invalid recvWindowMs/);
    assert.throws(() => validateRecvWindowMs(-100), /Invalid recvWindowMs/);
    assert.throws(() => validateRecvWindowMs(60001), /Invalid recvWindowMs/);
    assert.throws(() => validateRecvWindowMs(5000.5), /Invalid recvWindowMs/);
    assert.throws(() => validateRecvWindowMs("5000" as unknown as number), /Invalid recvWindowMs/);
    assert.throws(() => validateRecvWindowMs(NaN), /Invalid recvWindowMs/);
  });

  it("recognizes REQUEST_DEADLINE_EXCEEDED and TIMESTAMP_SKEW as retryable ConnectRPC errors", () => {
    const deadlineErr = new ConnectRpcError({
      message: "Deadline exceeded",
      httpStatus: 408,
      connectCode: "deadline_exceeded",
      domainCode: "REQUEST_DEADLINE_EXCEEDED",
      rawBody: "{}",
    });
    assert.equal(isRetryableConnectError(deadlineErr), true);

    const skewErr = new ConnectRpcError({
      message: "Timestamp skew detected",
      httpStatus: 400,
      connectCode: "invalid_argument",
      domainCode: "TIMESTAMP_SKEW",
      rawBody: "{}",
    });
    assert.equal(isRetryableConnectError(skewErr), true);

    const nonRetryableErr = new ConnectRpcError({
      message: "Bad request",
      httpStatus: 400,
      connectCode: "invalid_argument",
      domainCode: "INVALID_FIELD",
      rawBody: "{}",
    });
    assert.equal(isRetryableConnectError(nonRetryableErr), false);
  });
});
