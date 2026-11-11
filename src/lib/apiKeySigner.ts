import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";

/**
 * Ed25519 API key request signing implementation per Polyester specification:
 * https://testnet.polyester.com/docs/developer-docs/authentication-security/ed25519-api-keys
 *
 * Canonical string (5 lines separated by "\n", no trailing newline):
 *   <timestamp_ms>
 *   <uppercase_method>
 *   <path>
 *   <canonical_query>
 *   <body_sha256_hex>
 */

export interface SignedHeaders {
  "X-API-KEY-ID": string;
  "X-API-TIMESTAMP": string;
  "X-API-SIGNATURE": string;
}

/**
 * RFC 3986 percent-encoding for query keys and values.
 * Unreserved characters: ALPHA / DIGIT / "-" / "." / "_" / "~"
 * Spaces are encoded as "%20" and literal plus signs as "%2B".
 */
export function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Percent-decodes a query component where raw "+" is treated as space (" "),
 * matching the Polyester query normalization rules:
 * 1. Parse all query pairs, including repeated keys and empty values.
 * 2. Percent-decode each key and value. A raw `+` is decoded as a space.
 * 3. Sort pairs by decoded key, then by decoded value.
 * 4. Percent-encode each key and value using RFC 3986 query encoding.
 * 5. Write every pair as `key=value`, preserving repeated pairs, and join with `&`.
 */
export function normalizeQuery(rawQuery: string): string {
  const cleaned = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  if (!cleaned) {
    return "";
  }

  const pairs = cleaned.split("&").map((segment) => {
    const eqIdx = segment.indexOf("=");
    const rawKey = eqIdx === -1 ? segment : segment.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? "" : segment.slice(eqIdx + 1);

    const decodedKey = decodeURIComponent(rawKey.replace(/\+/g, "%20"));
    const decodedVal = decodeURIComponent(rawVal.replace(/\+/g, "%20"));
    return { key: decodedKey, val: decodedVal };
  });

  pairs.sort((a, b) => {
    if (a.key !== b.key) {
      return a.key < b.key ? -1 : 1;
    }
    if (a.val !== b.val) {
      return a.val < b.val ? -1 : 1;
    }
    return 0;
  });

  return pairs
    .map((p) => `${encodeRfc3986(p.key)}=${encodeRfc3986(p.val)}`)
    .join("&");
}

/**
 * Computes lowercase hexadecimal SHA-256 digest of a UTF-8 string or byte buffer.
 * Empty body hashes to: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 */
export function sha256Hex(body: string | Uint8Array = ""): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Builds the 5-line canonical string to sign.
 */
export function buildCanonicalString(params: {
  timestampMs: string;
  method: string;
  path: string;
  rawQuery?: string;
  body?: string | Uint8Array;
}): string {
  const { timestampMs, method, path, rawQuery = "", body = "" } = params;
  const upperMethod = method.toUpperCase();
  const canonicalQuery = normalizeQuery(rawQuery);
  const bodyHash = sha256Hex(body);

  return [timestampMs, upperMethod, path, canonicalQuery, bodyHash].join("\n");
}

/**
 * Parses a 32-byte Ed25519 private key from hex (with or without 0x prefix).
 */
export function parseEd25519PrivateKey(hexKey: string): Uint8Array {
  const clean = hexKey.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(
      "Invalid Ed25519 private key format: expected 64 hexadecimal characters (32 bytes)"
    );
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

let lastTimestampMs = 0;

/**
 * Generates a monotonically increasing Unix millisecond timestamp string so rapid
 * back-to-back or retried requests always carry a distinct X-API-TIMESTAMP.
 */
export function nextTimestampMs(): string {
  lastTimestampMs = Math.max(lastTimestampMs + 1, Date.now());
  return String(lastTimestampMs);
}

/**
 * Signs an API request with an Ed25519 key and returns the required headers.
 */
export function signApiKeyRequest(params: {
  apiKeyId: string;
  privateKeyHex: string;
  method: string;
  path: string;
  rawQuery?: string;
  body?: string | Uint8Array;
  timestampMs?: string;
}): SignedHeaders {
  const timestampMs = params.timestampMs ?? nextTimestampMs();
  const canonical = buildCanonicalString({
    timestampMs,
    method: params.method,
    path: params.path,
    rawQuery: params.rawQuery,
    body: params.body,
  });

  const privKeyBytes = parseEd25519PrivateKey(params.privateKeyHex);
  const msgBytes = new TextEncoder().encode(canonical);
  const signatureBytes = ed25519.sign(msgBytes, privKeyBytes);
  const signatureHex = Buffer.from(signatureBytes).toString("hex");

  return {
    "X-API-KEY-ID": params.apiKeyId,
    "X-API-TIMESTAMP": timestampMs,
    "X-API-SIGNATURE": signatureHex,
  };
}
