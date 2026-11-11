import type { BotState } from "../lib/state.js";

/**
 * Pure scheduling logic for the daily reward claim.
 *
 * Polyester's wallet-login endpoint is protected by Cloudflare bot mitigation and
 * returns HTTP 403 to non-browser clients. This module does NOT try to bypass that;
 * it decides when to (re)probe, how to back off, and what status to display so the
 * user can claim manually in the web app when automated login is blocked.
 */

export const CLAIM_PAGE_URL = "https://testnet.polyester.com";

/** Backoff schedule for transient (non-403) failures: 5m → 15m → 60m (cap). */
const TRANSIENT_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export type ClaimOutcome =
  | { kind: "success"; finalState: string; resetAtIso?: string }
  | { kind: "blocked" }
  | { kind: "transient"; message: string };

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function transientBackoffMs(retryCount: number): number {
  const idx = Math.min(Math.max(retryCount, 1), TRANSIENT_BACKOFF_MS.length) - 1;
  return TRANSIENT_BACKOFF_MS[idx];
}

/** Never schedule the next attempt past the next UTC reset: a new day always re-checks immediately. */
function capToReset(now: Date, targetMs: number): string {
  return new Date(Math.min(targetMs, nextUtcMidnight(now).getTime())).toISOString();
}

export function isClaimedToday(state: BotState, now: Date): boolean {
  return state.claimedForUtcDay === utcDay(now);
}

export function shouldAttemptDailyClaim(
  state: BotState,
  now: Date
): { shouldClaim: boolean; reason?: string } {
  if (isClaimedToday(state, now)) {
    return { shouldClaim: false, reason: `Already claimed for UTC day ${utcDay(now)}` };
  }
  if (state.nextClaimAttemptAt) {
    const nextMs = Date.parse(state.nextClaimAttemptAt);
    if (Number.isFinite(nextMs) && now.getTime() < nextMs) {
      return { shouldClaim: false, reason: `Next claim attempt at ${state.nextClaimAttemptAt}` };
    }
  }
  return { shouldClaim: true };
}

/**
 * Applies the outcome of a claim attempt to the persisted state (mutates and returns it).
 */
export function applyClaimOutcome(
  state: BotState,
  outcome: ClaimOutcome,
  now: Date,
  reprobeHours: number
): BotState {
  state.lastClaimAt = now.toISOString();

  if (outcome.kind === "success") {
    state.claimRetryCount = 0;
    state.lastClaimResetAt = outcome.resetAtIso;
    const done =
      outcome.finalState === "claimed" || outcome.finalState === "payout_delayed";
    if (done) {
      state.lastClaimState = "claimed";
      state.claimedForUtcDay = utcDay(now);
      state.nextClaimAttemptAt = nextUtcMidnight(now).toISOString();
    } else if (outcome.finalState === "processing") {
      state.lastClaimState = "retrying";
      state.nextClaimAttemptAt = capToReset(now, now.getTime() + transientBackoffMs(1));
    } else {
      // "unavailable", "social_verification_required", dry-run, etc.: checked, wait for reset
      state.lastClaimState = outcome.finalState === "available" ? "checked" : outcome.finalState;
      const resetMs = outcome.resetAtIso ? Date.parse(outcome.resetAtIso) : NaN;
      state.nextClaimAttemptAt =
        Number.isFinite(resetMs) && resetMs > now.getTime()
          ? new Date(resetMs).toISOString()
          : nextUtcMidnight(now).toISOString();
    }
    return state;
  }

  if (outcome.kind === "blocked") {
    state.claimRetryCount = 0;
    state.lastClaimState = "manual_required";
    state.nextClaimAttemptAt = capToReset(now, now.getTime() + reprobeHours * 3_600_000);
    return state;
  }

  state.claimRetryCount = (state.claimRetryCount ?? 0) + 1;
  state.lastClaimState = "retrying";
  state.nextClaimAttemptAt = capToReset(
    now,
    now.getTime() + transientBackoffMs(state.claimRetryCount)
  );
  return state;
}

/** Marks today as claimed after the user claimed manually in the web app (`--claim-done`). */
export function markClaimedManually(state: BotState, now: Date): BotState {
  state.lastClaimAt = now.toISOString();
  state.lastClaimState = "claimed";
  state.claimedForUtcDay = utcDay(now);
  state.claimRetryCount = 0;
  state.nextClaimAttemptAt = nextUtcMidnight(now).toISOString();
  return state;
}

/**
 * Opens the claim page in the user's browser at most once per UTC day.
 * Returns true if the opener was invoked.
 */
export function maybeOpenClaimPage(
  state: BotState,
  now: Date,
  enabled: boolean,
  opener: (url: string) => void
): boolean {
  if (!enabled || state.claimPageOpenedFor === utcDay(now)) return false;
  state.claimPageOpenedFor = utcDay(now);
  try {
    opener(CLAIM_PAGE_URL);
  } catch {
    // Opening the browser is best-effort only
  }
  return true;
}

export type ClaimStatusTone = "ok" | "warn" | "muted";

export function describeClaimStatus(
  state: BotState,
  now: Date
): { tone: ClaimStatusTone; text: string } {
  const day = utcDay(now);
  if (isClaimedToday(state, now)) {
    return { tone: "ok", text: `[OK] Claimed (${day})` };
  }
  if (state.lastClaimState === "manual_required") {
    return { tone: "warn", text: "[!] Manual claim: testnet.polyester.com" };
  }
  const nextMs = state.nextClaimAttemptAt ? Date.parse(state.nextClaimAttemptAt) : NaN;
  const minsLeft = Number.isFinite(nextMs) ? Math.ceil((nextMs - now.getTime()) / 60_000) : 0;
  if (state.lastClaimState === "retrying" && minsLeft > 0) {
    return { tone: "muted", text: `[~] Retry in ${minsLeft}m` };
  }
  if (state.lastClaimState && minsLeft > 0) {
    return { tone: "muted", text: `[-] ${state.lastClaimState} (${day})` };
  }
  return { tone: "muted", text: "[...] Checking" };
}
