import {
  PolyesterBrowserClient,
  POLYESTER_TESTNET_ENVIRONMENT,
  createMemoryAuthTokenStorage,
  type PolyesterEnvironment,
} from "@polyester/sdk";
import { createPolyesterAccountSigner } from "@polyester/sdk/account-signer";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { logger } from "../lib/logger.js";

/**
 * Creates a wallet-authenticated Polyester session client using the owner EOA
 * private key and the official @polyester/sdk SIWE flow:
 *
 * 1. Derive `accountAddress` (Smart Account) deterministically via `createPolyesterAccountSigner`
 *    (or use explicit `smartAccountAddress` if provided).
 * 2. Sign the server-issued EIP-4361 challenge with raw 65-byte EIP-191 `ownerAccount.signMessage`.
 * 3. Exchange for a session JWT stored in memory for `client.claims` calls.
 */

/**
 * Thrown when Polyester rejects wallet login with HTTP 403 / PERMISSION_DENIED.
 * In practice this is Cloudflare bot mitigation on the browser-only login endpoint
 * (response carries `Cf-Mitigated`). It is not retried aggressively and is not bypassed;
 * the user claims manually in the web app instead.
 */
export class WalletLoginBlockedError extends Error {
  readonly kind = "blocked" as const;
  constructor(message: string) {
    super(message);
    this.name = "WalletLoginBlockedError";
  }
}

export interface WalletSessionResult {
  client: PolyesterBrowserClient;
  accountId: string;
  username: string;
  smartAccountAddress: Hex;
  ownerAddress: Hex;
  expiresAt: Date;
}

export function buildEnvironment(apiUrlOverride?: string): PolyesterEnvironment {
  if (!apiUrlOverride || apiUrlOverride === POLYESTER_TESTNET_ENVIRONMENT.apiUrl) {
    return POLYESTER_TESTNET_ENVIRONMENT;
  }
  return {
    ...POLYESTER_TESTNET_ENVIRONMENT,
    apiUrl: apiUrlOverride,
  };
}

export async function loginWithOwnerWallet(params: {
  ownerPrivateKey: Hex;
  smartAccountAddress?: Hex;
  apiUrl?: string;
  originUri?: string;
}): Promise<WalletSessionResult> {
  const environment = buildEnvironment(params.apiUrl);
  const ownerAccount = privateKeyToAccount(params.ownerPrivateKey);

  // Derive Polyester Smart Account address deterministically with no RPC calls
  const derived = createPolyesterAccountSigner({
    environment,
    owner: ownerAccount,
  });

  const smartAccountAddress = (params.smartAccountAddress ?? derived.accountAddress) as Hex;

  // Per docs ("Wallet Login"): login requires the owner's raw 65-byte EIP-191 signature,
  // whereas createPolyesterAccountSigner wraps signatures in ERC-6492.
  const accountSigner = {
    environmentFingerprint: environment.fingerprint,
    accountAddress: smartAccountAddress,
    ownerAddress: ownerAccount.address,
    signMessage: (message: string) => ownerAccount.signMessage({ message }),
  };

  const client = new PolyesterBrowserClient({
    environment,
    accountSigner,
    tokenStorage: createMemoryAuthTokenStorage(),
  });

  const originUri = params.originUri ?? "https://testnet.polyester.com";
  logger.info("Authenticating wallet session for daily claim...", {
    ownerAddress: ownerAccount.address,
    smartAccountAddress,
  });

  let loginRes;
  try {
    loginRes = await client.auth.login({
      provider: "other",
      uri: originUri,
    });
  } catch (err) {
    const e = err as { name?: string; message?: string; code?: unknown; status?: unknown; cause?: unknown };
    const codeStr = String(e.code ?? "").toUpperCase();
    const msgStr = String(e.message ?? "");
    const causeStr = String((e.cause as { message?: string } | undefined)?.message ?? e.cause ?? "");

    const isAlreadyLinked =
      codeStr.includes("AUTH_WALLET_ALREADY_LINKED") ||
      codeStr.includes("WALLET_ALREADY_LINKED") ||
      msgStr.includes("AUTH_WALLET_ALREADY_LINKED") ||
      msgStr.includes("WALLET_ALREADY_LINKED") ||
      causeStr.includes("AUTH_WALLET_ALREADY_LINKED") ||
      causeStr.includes("WALLET_ALREADY_LINKED");

    if (isAlreadyLinked) {
      logger.fileOnly(
        "ERROR",
        `Wallet login rejected (wallet already linked): ${e.name}: ${e.message}`
      );
      throw new Error(
        "Wallet is already linked to another account (AUTH_WALLET_ALREADY_LINKED). Please log in with the account address the wallet is already linked to."
      );
    }

    const isForbidden =
      codeStr === "PERMISSION_DENIED" ||
      String(e.status) === "403" ||
      /HTTP 403/.test(msgStr);
    logger.fileOnly(
      isForbidden ? "WARN" : "ERROR",
      `Wallet login rejected: ${e.name}: ${e.message} (code=${String(e.code)}, status=${String(e.status)}, cause=${causeStr})`
    );
    if (isForbidden) {
      throw new WalletLoginBlockedError(
        "Wallet login blocked by Polyester bot protection (HTTP 403). Claim manually in the web app."
      );
    }
    throw err;
  }

  logger.info("Wallet session authenticated", {
    accountId: loginRes.accountId,
    username: loginRes.username || "(none)",
    expiresAt: loginRes.expiresAt.toISOString(),
  });

  return {
    client,
    accountId: loginRes.accountId,
    username: loginRes.username,
    smartAccountAddress,
    ownerAddress: ownerAccount.address,
    expiresAt: loginRes.expiresAt,
  };
}
