import { fromBinary } from "@bufbuild/protobuf";
import { swapPb } from "@polyester/sdk/unstable/gen";
import { signApiKeyRequest } from "./apiKeySigner.js";
import { logger } from "./logger.js";
import { fromU128 } from "./u128.js";

/**
 * ConnectRPC JSON-over-HTTP helper signed with Ed25519 API key headers.
 *
 * Per Polyester documentation:
 * - ConnectRPC routes are `POST https://api.testnet.polyester.com/<package>.<Service>/<Method>`
 * - Request headers:
 *     Content-Type: application/json
 *     Connect-Protocol-Version: 1
 *     X-API-KEY-ID, X-API-TIMESTAMP, X-API-SIGNATURE
 * - On retry, always generate a fresh timestamp and re-sign the exact request body.
 */

export interface ConnectErrorDetailItem {
  type?: string;
  value?: string;
  debug?: Record<string, unknown>;
  code?: string;
  swapId?: string | number;
  minAmountE18?: { hi?: string; lo?: string };
  maxAmountE18?: { hi?: string; lo?: string };
}

export interface DecodedSwapErrorDetail {
  codeName: string;
  swapId?: bigint;
  minAmountE18?: bigint;
  maxAmountE18?: bigint;
}

export class ConnectRpcError extends Error {
  public readonly httpStatus: number;
  public readonly connectCode: string;
  public readonly domainCode?: string;
  public readonly swapDetail?: DecodedSwapErrorDetail;
  public readonly details: ConnectErrorDetailItem[];
  public readonly rawBody: string;

  constructor(params: {
    message: string;
    httpStatus: number;
    connectCode: string;
    domainCode?: string;
    swapDetail?: DecodedSwapErrorDetail;
    details?: ConnectErrorDetailItem[];
    rawBody: string;
  }) {
    super(params.message);
    this.name = "ConnectRpcError";
    this.httpStatus = params.httpStatus;
    this.connectCode = params.connectCode;
    this.domainCode = params.domainCode;
    this.swapDetail = params.swapDetail;
    this.details = params.details ?? [];
    this.rawBody = params.rawBody;
  }
}

function decodeSwapDetailFromItems(
  details: ConnectErrorDetailItem[]
): { domainCode?: string; swapDetail?: DecodedSwapErrorDetail } {
  for (const d of details) {
    // 1. Try binary decoding if Connect returned protobuf wire bytes in `value`
    if (d.type?.endsWith("swap.v1.ErrorDetail") && typeof d.value === "string") {
      try {
        const bytes = Uint8Array.from(Buffer.from(d.value, "base64"));
        const decoded = fromBinary(swapPb.ErrorDetailSchema, bytes);
        const codeName = swapPb.ErrorCode[decoded.code] ?? String(decoded.code);
        return {
          domainCode: codeName,
          swapDetail: {
            codeName,
            swapId: decoded.swapId ? decoded.swapId : undefined,
            minAmountE18: decoded.minAmountE18
              ? fromU128({
                  hi: decoded.minAmountE18.hi.toString(),
                  lo: decoded.minAmountE18.lo.toString(),
                })
              : undefined,
            maxAmountE18: decoded.maxAmountE18
              ? fromU128({
                  hi: decoded.maxAmountE18.hi.toString(),
                  lo: decoded.maxAmountE18.lo.toString(),
                })
              : undefined,
          },
        };
      } catch {
        // fall through to debug / direct JSON fields
      }
    }

    // 2. Fallback to `debug` or direct fields
    const rawCode =
      typeof d.code === "string"
        ? d.code
        : typeof d.debug?.code === "string"
          ? d.debug.code
          : undefined;
    if (rawCode) {
      const minObj = (d.minAmountE18 ?? d.debug?.minAmountE18) as
        | { hi?: string; lo?: string }
        | undefined;
      const maxObj = (d.maxAmountE18 ?? d.debug?.maxAmountE18) as
        | { hi?: string; lo?: string }
        | undefined;
      return {
        domainCode: rawCode,
        swapDetail: {
          codeName: rawCode,
          minAmountE18: minObj ? fromU128(minObj) : undefined,
          maxAmountE18: maxObj ? fromU128(maxObj) : undefined,
        },
      };
    }
  }
  return {};
}

export function isRetryableConnectError(err: unknown): boolean {
  if (!(err instanceof ConnectRpcError)) {
    return false;
  }
  if (
    err.connectCode === "unavailable" ||
    err.connectCode === "resource_exhausted" ||
    err.httpStatus === 429 ||
    err.httpStatus === 502 ||
    err.httpStatus === 503 ||
    err.httpStatus === 504
  ) {
    return true;
  }
  if (
    err.domainCode === "SERVICE_UNAVAILABLE" ||
    err.domainCode === "QUOTE_UNAVAILABLE" ||
    err.domainCode === "RATE_LIMIT_EXCEEDED" ||
    err.domainCode === "SYSTEM_RATE_LIMITED" ||
    err.domainCode === "OVERLOADED" ||
    err.domainCode === "REQUEST_DEADLINE_EXCEEDED" ||
    err.domainCode === "TIMESTAMP_SKEW"
  ) {
    return true;
  }
  return false;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callConnectJsonWithApiKey<TReq extends object, TRes>(params: {
  apiUrl: string;
  procedurePath: string; // e.g. "/swap.v1.SwapService/QuoteSwap"
  body: TReq;
  apiKeyId: string;
  apiPrivateKey: string;
  recvWindowMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}): Promise<TRes> {
  const path = params.procedurePath.startsWith("/")
    ? params.procedurePath
    : `/${params.procedurePath}`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  // Serialize exact body once so every retry signs the identical payload bytes
  const bodyStr = JSON.stringify(params.body);
  const maxRetries = params.maxRetries ?? 2;
  const timeoutMs = params.timeoutMs ?? 20_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      logger.warn(
        `Retrying ${path} (attempt ${attempt + 1}/${maxRetries + 1}) after ${backoffMs}ms`
      );
      await sleep(backoffMs);
    }

    // Fresh timestamp and signature on every attempt per Ed25519 docs
    const signedHeaders = signApiKeyRequest({
      apiKeyId: params.apiKeyId,
      privateKeyHex: params.apiPrivateKey,
      method: "POST",
      path,
      rawQuery: "",
      body: bodyStr,
      recvWindowMs: params.recvWindowMs,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Connect-Protocol-Version": "1",
          ...signedHeaders,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      const rawText = await res.text();
      if (!res.ok) {
        let parsedErr: {
          code?: string;
          message?: string;
          details?: ConnectErrorDetailItem[];
        } = {};
        try {
          parsedErr = JSON.parse(rawText) as typeof parsedErr;
        } catch {
          // non-JSON response (e.g. Cloudflare HTML 403 challenge)
        }

        const connectCode = parsedErr.code ?? `http_${res.status}`;
        const details = Array.isArray(parsedErr.details) ? parsedErr.details : [];
        const { domainCode, swapDetail } = decodeSwapDetailFromItems(details);
        const msg =
          parsedErr.message ??
          (rawText.includes("Just a moment...") || rawText.includes("_cf_chl_opt")
            ? `Cloudflare challenge (HTTP ${res.status}) blocked request to ${url}`
            : `HTTP ${res.status} on ${path}: ${rawText.slice(0, 240)}`);

        const rpcErr = new ConnectRpcError({
          message: domainCode ? `${msg} [${domainCode}]` : msg,
          httpStatus: res.status,
          connectCode,
          domainCode,
          swapDetail,
          details,
          rawBody: rawText,
        });

        if (attempt < maxRetries && isRetryableConnectError(rpcErr)) {
          lastError = rpcErr;
          continue;
        }
        throw rpcErr;
      }

      return (rawText ? JSON.parse(rawText) : {}) as TRes;
    } catch (err) {
      lastError = err;
      if (err instanceof ConnectRpcError) {
        if (attempt < maxRetries && isRetryableConnectError(err)) {
          continue;
        }
        throw err;
      }
      // Network or timeout error
      if (attempt < maxRetries) {
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
