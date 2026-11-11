import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persistent state store (`state.json`) so the 13h schedule, last claim info,
 * and recent swap summaries survive process restarts.
 */

export interface SwapRecordSummary {
  pair: string;
  leg1SwapId?: string;
  leg1Status: string;
  spentQuote: string;
  receivedBase: string;
  leg2SwapId?: string;
  leg2Status?: string;
  returnedQuote?: string;
  error?: string;
  ts: string;
}

export interface WalletStats {
  name: string;
  totalVolumeUsd: number;
  totalMakerFills: number;
}

export interface BotState {
  lastCycleAt?: string;
  lastClaimAt?: string;
  lastClaimState?: string;
  lastClaimResetAt?: string;
  /** UTC day (YYYY-MM-DD) the daily reward was confirmed claimed (automatically or via --claim-done). */
  claimedForUtcDay?: string;
  /** Earliest time the bot may attempt the next automated claim/probe. */
  nextClaimAttemptAt?: string;
  /** Consecutive transient (non-403) claim failures, for backoff. */
  claimRetryCount?: number;
  /** UTC day the manual-claim page was last opened in the browser. */
  claimPageOpenedFor?: string;
  totalCyclesRun: number;
  totalVolumeUsd?: number;
  totalMakerFills?: number;
  walletStats?: Record<string, WalletStats>;
  lastTrendingPairs?: string[];
  recentSwaps: SwapRecordSummary[];
}

const DEFAULT_STATE_PATH = join(process.cwd(), "state.json");

export function loadState(filePath: string = DEFAULT_STATE_PATH): BotState {
  if (!existsSync(filePath)) {
    return {
      totalCyclesRun: 0,
      recentSwaps: [],
    };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return {
      totalCyclesRun: typeof parsed.totalCyclesRun === "number" ? parsed.totalCyclesRun : 0,
      totalVolumeUsd: typeof parsed.totalVolumeUsd === "number" ? parsed.totalVolumeUsd : 0,
      totalMakerFills: typeof parsed.totalMakerFills === "number" ? parsed.totalMakerFills : 0,
      walletStats: parsed.walletStats ?? {},
      recentSwaps: Array.isArray(parsed.recentSwaps) ? parsed.recentSwaps : [],
      lastCycleAt: parsed.lastCycleAt,
      lastClaimAt: parsed.lastClaimAt,
      lastClaimState: parsed.lastClaimState,
      lastClaimResetAt: parsed.lastClaimResetAt,
      claimedForUtcDay: parsed.claimedForUtcDay,
      nextClaimAttemptAt: parsed.nextClaimAttemptAt,
      claimRetryCount: typeof parsed.claimRetryCount === "number" ? parsed.claimRetryCount : 0,
      claimPageOpenedFor: parsed.claimPageOpenedFor,
      lastTrendingPairs: parsed.lastTrendingPairs,
    };
  } catch {
    return {
      totalCyclesRun: 0,
      recentSwaps: [],
    };
  }
}

export function saveState(state: BotState, filePath: string = DEFAULT_STATE_PATH): void {
  const trimmed: BotState = {
    ...state,
    // Keep the most recent 100 swap summaries to bound file size
    recentSwaps: state.recentSwaps.slice(-100),
  };
  writeFileSync(filePath, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
}
