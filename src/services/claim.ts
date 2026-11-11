import {
  PolyesterError,
  PreconditionFailedError,
  type PolyesterBrowserClient,
  type DailyClaimReward,
} from "@polyester/sdk";
import { sleep } from "../lib/connect.js";
import { logger } from "../lib/logger.js";

/**
 * Daily Testnet Reward claim service (`claims.v1.ClaimsService`).
 *
 * Per Polyester documentation ("Testnet funds" & "Account services - client.claims"):
 * - Requires a session JWT (API keys are rejected).
 * - Policy is `UTC_DAILY`: one claim per root account per UTC calendar day.
 * - States: "available", "processing", "claimed", "unavailable", "payout_delayed", "unspecified".
 * - Requires a verified X or Discord account linked once in the web app.
 */

export interface ClaimExecutionSummary {
  attempted: boolean;
  finalState: string;
  claimId?: string;
  rewards: DailyClaimReward[];
  resetAtIso?: string;
  subaccountId?: string;
  payoutDelayReason?: string;
  note?: string;
}

function formatResetAt(resetAtMs?: number): string | undefined {
  if (!resetAtMs || !Number.isFinite(resetAtMs)) {
    return undefined;
  }
  return new Date(resetAtMs).toISOString();
}

export async function checkAndClaimDailyReward(params: {
  sessionClient: PolyesterBrowserClient;
  subaccountId?: string;
  dryRun?: boolean;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}): Promise<ClaimExecutionSummary> {
  const {
    sessionClient,
    subaccountId,
    dryRun = false,
    pollIntervalMs = 3000,
    maxPollAttempts = 20,
  } = params;

  const status = await sessionClient.claims.getDailyClaimStatus();
  const resetAtIso = formatResetAt(status.resetAt);

  logger.info("Checked daily reward status", {
    state: status.state,
    campaign: status.campaign?.name ?? status.campaign?.campaignId ?? "default",
    rewards: status.rewards.map((r) => `${r.amount} ${r.assetCode}`),
    resetAt: resetAtIso ?? "unknown",
    existingSubaccountId: status.subaccountId ?? "main",
  });

  if (status.state === "claimed") {
    return {
      attempted: false,
      finalState: status.state,
      claimId: status.claimId || undefined,
      rewards: status.rewards,
      resetAtIso,
      subaccountId: status.subaccountId,
      note: `Already claimed for current UTC day. Next reset at ${resetAtIso ?? "00:00 UTC"}.`,
    };
  }

  if (status.state === "unavailable") {
    return {
      attempted: false,
      finalState: status.state,
      rewards: status.rewards,
      resetAtIso,
      note: `No eligible daily reward available right now. Next reset at ${resetAtIso ?? "00:00 UTC"}.`,
    };
  }

  if (status.state === "payout_delayed") {
    return {
      attempted: false,
      finalState: status.state,
      claimId: status.claimId || undefined,
      rewards: status.rewards,
      resetAtIso,
      subaccountId: status.subaccountId,
      payoutDelayReason: status.payoutDelayReason,
      note: `Claim is already recorded; payout is delayed (${status.payoutDelayReason ?? "paused"}) and will be paid automatically.`,
    };
  }

  if (dryRun) {
    logger.info("[DRY RUN] Skipping claimDailyReward() mutation", {
      wouldClaimState: status.state,
      targetAccount: subaccountId ?? "main",
      rewards: status.rewards.map((r) => `${r.amount} ${r.assetCode}`),
    });
    return {
      attempted: false,
      finalState: status.state,
      rewards: status.rewards,
      resetAtIso,
      subaccountId,
      note: "Dry-run mode: daily reward was not claimed.",
    };
  }

  // If state is "available" (or "processing" from an earlier attempt), submit/confirm claim
  let claimState: string = status.state;
  let claimId: string | undefined = status.claimId || undefined;
  let rewards: DailyClaimReward[] = status.rewards;
  let targetSubaccount: string | undefined = status.subaccountId ?? subaccountId;

  if (status.state === "available") {
    try {
      logger.info("Submitting daily reward claim...", {
        destination: subaccountId ? `subaccount:${subaccountId}` : "main account",
      });
      const claimed = await sessionClient.claims.claimDailyReward(
        subaccountId ? { subaccountId } : undefined
      );
      claimState = claimed.state;
      claimId = claimed.claimId || claimId;
      rewards = claimed.rewards.length > 0 ? claimed.rewards : rewards;
      targetSubaccount = claimed.subaccountId ?? targetSubaccount;

      logger.info("Daily reward claim submitted", {
        claimId,
        state: claimState,
        rewards: rewards.map((r) => `${r.amount} ${r.assetCode}`),
      });
    } catch (err) {
      if (err instanceof PreconditionFailedError || err instanceof PolyesterError) {
        const detailCode = (err as { detail?: { code?: string } }).detail?.code;
        if (detailCode === "SOCIAL_VERIFICATION_REQUIRED" || err.message.includes("SOCIAL_VERIFICATION")) {
          logger.warn(
            "Daily reward claim requires one-time X or Discord verification in the Polyester web app (gift icon in top nav)."
          );
          return {
            attempted: true,
            finalState: "social_verification_required",
            rewards,
            resetAtIso,
            note: "Link X or Discord once in the Polyester web app to enable daily reward claims.",
          };
        }
        if (
          detailCode === "CLAIM_TEMPORARILY_UNAVAILABLE" ||
          detailCode === "CLAIM_PAYOUT_UNAVAILABLE"
        ) {
          logger.warn("Daily reward payout is currently paused; claim will complete when resumed.", {
            detailCode,
          });
          return {
            attempted: true,
            finalState: "payout_delayed",
            rewards,
            resetAtIso,
            payoutDelayReason: detailCode,
          };
        }
      }
      throw err;
    }
  }

  // Poll status while "processing" until "claimed" or "payout_delayed"
  let pollCount = 0;
  let payoutDelayReason: string | undefined;
  while (claimState === "processing" && pollCount < maxPollAttempts) {
    pollCount++;
    await sleep(pollIntervalMs);
    const updated = await sessionClient.claims.getDailyClaimStatus();
    claimState = updated.state;
    claimId = updated.claimId || claimId;
    rewards = updated.rewards.length > 0 ? updated.rewards : rewards;
    payoutDelayReason = updated.payoutDelayReason;
    logger.info(`Polling daily claim status (${pollCount}/${maxPollAttempts})`, {
      state: claimState,
      payoutDelayReason,
    });
  }

  return {
    attempted: true,
    finalState: claimState,
    claimId,
    rewards,
    resetAtIso,
    subaccountId: targetSubaccount,
    payoutDelayReason,
  };
}
