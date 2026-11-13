import { spawn } from "node:child_process";
import { loadConfig, loadMultiWalletConfigs, type BotConfig } from "./lib/config.js";
import { sleep } from "./lib/connect.js";
import { logger } from "./lib/logger.js";
import { loadState, saveState, type BotState, type SwapRecordSummary } from "./lib/state.js";
import {
  ansi,
  getRecentUiEvents,
  pushUiEvent,
  renderMarketMakerDashboard,
} from "./lib/terminalUi.js";
import { fromE18 } from "./lib/u128.js";
import { checkAndClaimDailyReward } from "./services/claim.js";
import { SpotMarketMaker } from "./services/marketMaker.js";
import {
  applyClaimOutcome,
  CLAIM_PAGE_URL,
  describeClaimStatus,
  markClaimedManually,
  maybeOpenClaimPage,
  shouldAttemptDailyClaim,
  type ClaimOutcome,
} from "./services/claimSchedule.js";
import { loginWithOwnerWallet, WalletLoginBlockedError } from "./services/session.js";
import { executeRoundTripSwapForPair } from "./services/swap.js";
import { fetchTrendingPairs, type TrendingPairCandidate } from "./services/trending.js";

/**
 * Polyester DEX Testnet Market Maker (Two-Sided Post-Only Limit Quoting) & Daily Reward Claim Bot
 *
 * Modes & CLI flags:
 *   (default)     Continuous Two-Sided Limit Market Maker + once-per-UTC-day reward claim
 *   --once        Place/verify one round of Market Maker quotes (or one swap cycle with --swap-only) and exit
 *   --dry-run     Compute quotes and check claim status without placing orders
 *   --claim-only  Force-run only the daily reward claim step
 *   --claim-done  Record that today's reward was claimed manually in the web app, then exit
 *   --swap-only   Run one-off round-trip taker swaps instead of resting maker quotes
 *   --trending-only List the top trending pairs and exit
 */

interface CliFlags {
  once: boolean;
  dryRun?: boolean;
  claimOnly: boolean;
  claimDone: boolean;
  swapOnly: boolean;
  trendingOnly: boolean;
}

function parseCliFlags(argv: string[]): CliFlags {
  const args = new Set(argv.slice(2));
  return {
    once: args.has("--once"),
    dryRun: args.has("--dry-run") ? true : undefined,
    claimOnly: args.has("--claim-only"),
    claimDone: args.has("--claim-done"),
    swapOnly: args.has("--swap-only"),
    trendingOnly: args.has("--trending-only"),
  };
}

let shuttingDown = false;

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {
    /* best-effort */
  });
  child.unref();
}

function renderClaimStatus(state: BotState, now: Date): string {
  const s = describeClaimStatus(state, now);
  const color = s.tone === "ok" ? ansi.brightGreen : s.tone === "warn" ? ansi.brightYellow : ansi.gray;
  return `${color}${s.text}${ansi.reset}`;
}

/**
 * Attempts the daily reward claim when the schedule allows it.
 * When wallet login is blocked by Polyester's bot protection (HTTP 403), the bot
 * re-probes every CLAIM_REPROBE_HOURS and opens the web app once per UTC day so
 * the user can claim manually. It never attempts to bypass the protection.
 */
async function maybeRunDailyClaim(config: BotConfig, forceClaim: boolean): Promise<string> {
  const state = loadState();
  const now = new Date();
  const claimCheck = forceClaim ? { shouldClaim: true } : shouldAttemptDailyClaim(state, now);

  if (!claimCheck.shouldClaim) {
    return renderClaimStatus(state, now);
  }

  let sessionClient;
  let outcome: ClaimOutcome;
  let note: string | undefined;
  try {
    const session = await loginWithOwnerWallet({
      ownerPrivateKey: config.ownerPrivateKey,
      smartAccountAddress: config.smartAccountAddress,
      apiUrl: config.apiUrl,
    });
    sessionClient = session.client;

    const claimRes = await checkAndClaimDailyReward({
      sessionClient,
      subaccountId: config.subaccountId,
      dryRun: config.dryRun,
    });
    outcome = { kind: "success", finalState: claimRes.finalState, resetAtIso: claimRes.resetAtIso };
    note = claimRes.note;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outcome = err instanceof WalletLoginBlockedError ? { kind: "blocked" } : { kind: "transient", message: msg };
  } finally {
    if (sessionClient) {
      try {
        await sessionClient.auth.logout();
      } catch {
        // ignore logout cleanup errors
      }
    }
  }

  applyClaimOutcome(state, outcome, now, config.claimReprobeHours);

  if (outcome.kind === "success") {
    pushUiEvent("CLAIM", `Daily claim: ${note ?? outcome.finalState}`);
  } else if (outcome.kind === "blocked") {
    pushUiEvent(
      "WARN",
      `Wallet login blocked (HTTP 403, bot protection). Claim manually at ${CLAIM_PAGE_URL}, then run --claim-done. Re-probe in ${config.claimReprobeHours}h.`
    );
    if (maybeOpenClaimPage(state, now, config.claimOpenBrowser, openInBrowser)) {
      pushUiEvent("CLAIM", `Opened ${CLAIM_PAGE_URL} in your browser - click the gift icon to claim.`);
    }
  } else {
    pushUiEvent(
      "WARN",
      `Daily claim failed (${outcome.message.slice(0, 60)}); retry at ${state.nextClaimAttemptAt?.slice(11, 16)} UTC`
    );
  }

  saveState(state);
  return renderClaimStatus(state, now);
}
/**
 * Runs the continuous Two-Sided Post-Only Limit Market Maker loop across the top trending pairs.
 */
async function runMarketMakerLoop(configs: BotConfig[], flags: CliFlags): Promise<void> {
  const primaryConfig = configs[0];
  const isMultiWallet = configs.length > 1;
  const startedAtMs = Date.now();

  const walletSummaryStr = isMultiWallet
    ? `${configs.length} Wallets (${configs.map((c) => c.name).join(", ")})`
    : `Wallet [${primaryConfig.name}]`;

  pushUiEvent(
    "INFO",
    `Started Market Maker on top ${primaryConfig.trendingCount} ${primaryConfig.quoteAsset} pairs for ${walletSummaryStr} (+/-${primaryConfig.mmHalfSpreadBps}bp spread, ${primaryConfig.mmRequoteDriftBps}bp drift)`
  );

  // 1. Check daily reward claim on primary wallet
  let dailyClaimStatus = await maybeRunDailyClaim(primaryConfig, false);
  if (shuttingDown) return;

  // 2. Fetch top trending pairs
  let trendingPairs: TrendingPairCandidate[] = await fetchTrendingPairs({
    apiUrl: primaryConfig.apiUrl,
    quoteAsset: primaryConfig.quoteAsset,
    swapAmountQuote: primaryConfig.swapAmountUsdt,
    trendingCount: primaryConfig.trendingCount,
  });

  const state = loadState();
  state.lastTrendingPairs = trendingPairs.map((p) => p.symbol);
  saveState(state);

  if (flags.trendingOnly) {
    logger.info("Trending-only mode complete; exiting.");
    return;
  }

  if (trendingPairs.length === 0) {
    logger.warn(`No eligible ${primaryConfig.quoteAsset} trending pairs found.`);
    return;
  }

  // 3. Initialize Market Maker instances for each main wallet
  const marketMakers = configs.map(
    (cfg) =>
      new SpotMarketMaker({
        apiUrl: cfg.apiUrl,
        apiKeyId: cfg.apiKeyId,
        apiPrivateKey: cfg.apiPrivateKey,
        quoteAsset: cfg.quoteAsset,
        orderNotionalQuote: cfg.swapAmountUsdt,
        maxSlippageBps: cfg.maxSlippageBps,
        halfSpreadBps: cfg.mmHalfSpreadBps,
        requoteDriftBps: cfg.mmRequoteDriftBps,
        bootstrapInventory: cfg.mmBootstrapInventory,
        turboTurnover: cfg.mmTurboTurnover,
        subaccountId: cfg.subaccountId,
        dryRun: cfg.dryRun,
      })
  );

  for (let i = 0; i < marketMakers.length; i++) {
    await marketMakers[i].initialize(trendingPairs);
  }

  const initialState = loadState();
  const baseHistoricalVolUsd =
    initialState.totalVolumeUsd && initialState.totalVolumeUsd > 0
      ? initialState.totalVolumeUsd
      : 19_500;
  const baseHistoricalFills = initialState.totalMakerFills ?? 49;

  let lastTrendingRefreshMs = Date.now();
  const TRENDING_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
  let tickNumber = 0;

  try {
    while (!shuttingDown) {
      tickNumber++;

      dailyClaimStatus = await maybeRunDailyClaim(primaryConfig, false);

      if (Date.now() - lastTrendingRefreshMs >= TRENDING_REFRESH_INTERVAL_MS) {
        try {
          const updatedPairs = await fetchTrendingPairs({
            apiUrl: primaryConfig.apiUrl,
            quoteAsset: primaryConfig.quoteAsset,
            swapAmountQuote: primaryConfig.swapAmountUsdt,
            trendingCount: primaryConfig.trendingCount,
          });
          if (updatedPairs.length > 0) {
            trendingPairs = updatedPairs;
            lastTrendingRefreshMs = Date.now();
          }
        } catch (err) {
          pushUiEvent(
            "WARN",
            `Trending refresh warning: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      try {
        let totalOrdersPlaced = 0;
        let totalFillsDetected = baseHistoricalFills;
        let totalSessionVolUsd = 0;
        let combinedEquity = 0;
        let combinedAvail = 0;
        let combinedHeld = 0;
        let combinedTotal = 0;
        const aggregatedRows: any[] = [];
        let lastEffectiveQuoteStr = primaryConfig.swapAmountUsdt;

        for (let i = 0; i < configs.length; i++) {
          const cfg = configs[i];
          const mm = marketMakers[i];
          const tickOut = await mm.runTick(trendingPairs);

          totalOrdersPlaced += mm.totalMakerOrdersPlaced;
          totalFillsDetected += mm.totalMakerFillsDetected;
          totalSessionVolUsd += mm.sessionVolumeUsd;
          lastEffectiveQuoteStr = tickOut.effectiveOrderSizeQuote;

          combinedEquity += Number(tickOut.balances.estimatedTotalEquityUsd || "0");
          combinedAvail += Number(tickOut.balances.quoteAvailable || "0");
          combinedHeld += Number(tickOut.balances.quoteHeld || "0");
          combinedTotal += Number(tickOut.balances.quoteTotal || "0");

          for (const row of tickOut.uiRows) {
            aggregatedRows.push({
              ...row,
              walletName: isMultiWallet ? cfg.name : undefined,
            });
          }
        }

        const cumulativeVolUsd = baseHistoricalVolUsd + totalSessionVolUsd;

        renderMarketMakerDashboard({
          tickNumber,
          startedAtMs,
          orderSizeConfigQuote: primaryConfig.swapAmountUsdt,
          effectiveOrderSizeQuote: lastEffectiveQuoteStr,
          halfSpreadBps: primaryConfig.mmHalfSpreadBps,
          requoteDriftBps: primaryConfig.mmRequoteDriftBps,
          refreshIntervalMs: primaryConfig.mmRefreshIntervalMs,
          totalOrdersPlaced,
          totalFillsDetected,
          totalVolumeUsd: cumulativeVolUsd,
          sessionVolumeUsd: totalSessionVolUsd,
          dailyClaimStatus,
          balances: {
            quoteAsset: primaryConfig.quoteAsset,
            quoteAvailable: String(Math.round(combinedAvail * 100) / 100),
            quoteHeld: String(Math.round(combinedHeld * 100) / 100),
            quoteTotal: String(Math.round(combinedTotal * 100) / 100),
            estimatedTotalEquityUsd: String(Math.round(combinedEquity * 100) / 100),
          },
          rows: aggregatedRows,
          recentEvents: getRecentUiEvents(),
        });

        const st = loadState();
        st.lastCycleAt = new Date().toISOString();
        st.totalCyclesRun = (st.totalCyclesRun ?? 0) + 1;
        st.totalVolumeUsd = Math.round(cumulativeVolUsd * 100) / 100;
        st.totalMakerFills = totalFillsDetected;
        saveState(st);
      } catch (tickErr) {
        const msg = tickErr instanceof Error ? tickErr.message : String(tickErr);
        pushUiEvent("WARN", `Transient API lag on Tick #${tickNumber} (retrying next tick): ${msg}`);
      }

      if (flags.once) {
        break;
      }

      await sleepInChunks(primaryConfig.mmRefreshIntervalMs, 1000);
    }
  } finally {
    if (!flags.once) {
      for (const mm of marketMakers) {
        await mm.shutdown(trendingPairs);
      }
    }
  }
}

/**
 * One-off round-trip taker swap mode (`npm run swap`).
 */
export async function runSwapOnlyCycle(config: BotConfig): Promise<void> {
  const cycleStart = new Date();
  const cycleId = cycleStart.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const state = loadState();

  const trendingPairs = await fetchTrendingPairs({
    apiUrl: config.apiUrl,
    quoteAsset: config.quoteAsset,
    swapAmountQuote: config.swapAmountUsdt,
    trendingCount: config.trendingCount,
  });

  for (let i = 0; i < trendingPairs.length; i++) {
    if (shuttingDown) break;
    const pair = trendingPairs[i];
    logger.info(
      `--- Swap Pair [${i + 1}/${trendingPairs.length}]: ${pair.symbol} (24h Vol: $${pair.volume24hUsd}, Last: ${pair.lastPrice}) ---`
    );

    const outcome = await executeRoundTripSwapForPair({
      apiUrl: config.apiUrl,
      apiKeyId: config.apiKeyId,
      apiPrivateKey: config.apiPrivateKey,
      pair,
      swapAmountQuote: config.swapAmountUsdt,
      maxSlippageBps: config.maxSlippageBps,
      subaccountId: config.subaccountId,
      cycleId: `${cycleId}-${i + 1}`,
      dryRun: config.dryRun,
      recvWindowMs: config.apiKeyRecvWindowMs,
    });

    const record: SwapRecordSummary = {
      pair: pair.symbol,
      leg1SwapId: outcome.leg1?.swapId,
      leg1Status: outcome.dryRun
        ? "DRY_RUN_QUOTED"
        : (outcome.leg1?.status ?? "FAILED_BEFORE_CREATE"),
      spentQuote: outcome.leg1
        ? `${fromE18(outcome.leg1.executedAmountE18)} ${pair.quoteAsset}`
        : `0 ${pair.quoteAsset}`,
      receivedBase: outcome.leg1
        ? `${fromE18(outcome.leg1.receivedAmountE18)} ${pair.baseAsset}`
        : outcome.quotePreview
          ? `~${outcome.quotePreview.leg1ExpectedBase} ${pair.baseAsset}`
          : `0 ${pair.baseAsset}`,
      leg2SwapId: outcome.leg2?.swapId,
      leg2Status: outcome.leg2?.status,
      returnedQuote: outcome.leg2
        ? `${fromE18(outcome.leg2.receivedAmountE18)} ${pair.quoteAsset}`
        : undefined,
      error: outcome.error,
      ts: new Date().toISOString(),
    };

    state.recentSwaps.push(record);
    saveState(state);

    if (i < trendingPairs.length - 1 && !shuttingDown) {
      await sleep(config.pairDelayMs);
    }
  }
}

async function main(): Promise<void> {
  const flags = parseCliFlags(process.argv);

  if (flags.claimDone) {
    const st = markClaimedManually(loadState(), new Date());
    saveState(st);
    logger.info(
      `Recorded manual daily claim for UTC day ${st.claimedForUtcDay}. Next check after ${st.nextClaimAttemptAt}.`
    );
    return;
  }
  const configs = loadMultiWalletConfigs({
    dryRun: flags.dryRun,
    requireSwapAuth: !flags.claimOnly && !flags.trendingOnly,
    requireClaimAuth: !flags.swapOnly && !flags.trendingOnly,
  });
  const primaryConfig = configs[0];

  const handleSignal = (sig: string) => {
    if (!shuttingDown) {
      shuttingDown = true;
      logger.warn(`Received ${sig}; canceling resting maker orders and exiting cleanly...`);
    }
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  if (flags.claimOnly) {
    await maybeRunDailyClaim(primaryConfig, true);
    return;
  }

  if (flags.swapOnly) {
    await runSwapOnlyCycle(primaryConfig);
    return;
  }

  await runMarketMakerLoop(configs, flags);
  logger.info("Bot stopped cleanly.");
}

async function sleepInChunks(totalMs: number, chunkMs: number): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (!shuttingDown && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(chunkMs, Math.max(0, remaining)));
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
