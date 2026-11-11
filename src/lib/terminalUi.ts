import { logger } from "./logger.js";

/**
 * Rich ANSI Terminal UI (TUI) for the Polyester Two-Sided Limit Market Maker Bot.
 * Renders a structured, colorized live table of resting Bid/Ask quotes,
 * portfolio inventory, KPIs, and recent activity feed without scrolling log spam.
 */

const ESC = "\x1b[";
export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}36m`,
  brightCyan: `${ESC}96m`,
  green: `${ESC}32m`,
  brightGreen: `${ESC}92m`,
  yellow: `${ESC}33m`,
  brightYellow: `${ESC}93m`,
  red: `${ESC}31m`,
  brightRed: `${ESC}91m`,
  magenta: `${ESC}35m`,
  brightMagenta: `${ESC}95m`,
  white: `${ESC}97m`,
  gray: `${ESC}90m`,
  bgBlue: `${ESC}44m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgRed: `${ESC}41m`,
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

/** Terminal display width: every non-ANSI character is 1 cell when using strict ASCII/CP437 symbols. */
export function visibleWidth(str: string): number {
  return stripAnsi(str).length;
}

/** Truncate to a visible width (keeps ANSI codes intact), appending a reset. */
export function truncateVisible(str: string, width: number): string {
  if (visibleWidth(str) <= width) return str;
  let out = "";
  let w = 0;
  let i = 0;
  while (i < str.length) {
    const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(str.codePointAt(i)!);
    const cw = visibleWidth(ch);
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + ansi.reset;
}

export function padEndVisible(str: string, width: number): string {
  const len = visibleWidth(str);
  if (len >= width) return truncateVisible(str, width);
  return str + " ".repeat(width - len);
}

export function padStartVisible(str: string, width: number): string {
  const len = visibleWidth(str);
  if (len >= width) return truncateVisible(str, width);
  return " ".repeat(width - len) + str;
}
export function formatCompactNumber(valStr: string | undefined, maxDecimals = 4): string {
  if (!valStr) return "-";
  const num = Number(valStr);
  if (!Number.isFinite(num)) return valStr;
  if (num === 0) return "0";
  const abs = Math.abs(num);
  if (abs >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 10_000) {
    return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (abs >= 1) {
    return num.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
  }
  if (abs >= 0.001) {
    return num.toFixed(Math.min(6, maxDecimals + 2)).replace(/\.?0+$/, "");
  }
  return num.toFixed(8).replace(/\.?0+$/, "");
}

export function formatPrice(priceStr: string | undefined): string {
  if (!priceStr) return "-";
  const num = Number(priceStr);
  if (!Number.isFinite(num) || num === 0) return priceStr;
  if (num >= 1000) {
    return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (num >= 1) {
    return num.toFixed(4).replace(/\.?0+$/, "");
  }
  if (num >= 0.01) {
    return num.toFixed(5).replace(/\.?0+$/, "");
  }
  return num.toFixed(8).replace(/\.?0+$/, "");
}

export interface UiPairRow {
  walletName?: string;
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  action: "QUOTED" | "HELD" | "SKIPPED" | "DRY_RUN" | "ERROR";
  midPrice: string;
  bidPrice?: string;
  askPrice?: string;
  bidQty?: string;
  askQty?: string;
  bidOrderId?: string;
  askOrderId?: string;
  spreadBps?: number;
  driftBps?: number;
  requoteDriftBps: number;
  baseBalanceTotal: string;
  baseValueUsd: string;
  filledSinceLastTick?: ("BID" | "ASK")[];
  note?: string;
  error?: string;
}

export interface UiBalanceSummary {
  quoteAsset: string;
  quoteAvailable: string;
  quoteHeld: string;
  quoteTotal: string;
  estimatedTotalEquityUsd: string;
}

export interface UiDashboardState {
  tickNumber: number;
  startedAtMs: number;
  orderSizeConfigQuote: string;
  effectiveOrderSizeQuote: string;
  halfSpreadBps: number;
  requoteDriftBps: number;
  refreshIntervalMs: number;
  totalOrdersPlaced: number;
  totalFillsDetected: number;
  totalVolumeUsd: number;
  sessionVolumeUsd: number;
  dailyClaimStatus: string;
  balances: UiBalanceSummary;
  rows: UiPairRow[];
  recentEvents: string[];
}

const MAX_RECENT_EVENTS = 7;
const eventRingBuffer: string[] = [];

export function pushUiEvent(
  level: "FILL" | "QUOTE" | "REBALANCE" | "CLAIM" | "WARN" | "ERROR" | "INFO",
  message: string
): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const timeTag = `${ansi.gray}${hh}:${mm}:${ss}${ansi.reset}`;

  let badge = `${ansi.cyan}[INFO ]${ansi.reset}`;
  if (level === "FILL") badge = `${ansi.brightGreen}${ansi.bold}[FILL ]${ansi.reset}`;
  else if (level === "QUOTE") badge = `${ansi.brightCyan}[QUOTE]${ansi.reset}`;
  else if (level === "REBALANCE") badge = `${ansi.brightMagenta}[INV  ]${ansi.reset}`;
  else if (level === "CLAIM") badge = `${ansi.brightYellow}[CLAIM]${ansi.reset}`;
  else if (level === "WARN") badge = `${ansi.yellow}[WARN ]${ansi.reset}`;
  else if (level === "ERROR") badge = `${ansi.brightRed}[ERROR]${ansi.reset}`;

  const formatted = `${timeTag} ${badge} ${message}`;
  eventRingBuffer.push(formatted);
  if (eventRingBuffer.length > MAX_RECENT_EVENTS) {
    eventRingBuffer.shift();
  }

  // Always persist to daily log file without cluttering stdout
  logger.fileOnly(
    level === "ERROR" ? "ERROR" : level === "WARN" ? "WARN" : "INFO",
    stripAnsi(`[${level}] ${message}`)
  );
}

export function getRecentUiEvents(): string[] {
  return [...eventRingBuffer];
}

function formatUptime(startedAtMs: number): string {
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function renderMarketMakerDashboard(state: UiDashboardState): void {
  const lines: string[] = [];

  // Move cursor to top-left and clear screen + scrollback so frames update cleanly in place
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
  } else {
    lines.push("");
  }

  // Exact inner content width = sum of 8 table columns (110) + 7 single-space separators (7) = 117
  // Total box width W = 117 + 4 ("║ " and " ║") = 121
  const W = 121;
  const topBorder = `${ansi.cyan}╔${"═".repeat(W - 2)}╗${ansi.reset}`;
  const midBorder = `${ansi.cyan}╠${"═".repeat(W - 2)}╣${ansi.reset}`;
  const botBorder = `${ansi.cyan}╚${"═".repeat(W - 2)}╝${ansi.reset}`;

  const boxRow = (content: string) =>
    `${ansi.cyan}║${ansi.reset} ${padEndVisible(content, W - 4)} ${ansi.cyan}║${ansi.reset}`;

  lines.push(topBorder);

  const titleLeft = `${ansi.bold}${ansi.brightCyan}>> POLYESTER DEX TESTNET - TWO-SIDED LIMIT MARKET MAKER${ansi.reset}`;
  const uptimeStr = `${ansi.gray}Uptime:${ansi.reset} ${ansi.white}${formatUptime(state.startedAtMs)}${ansi.reset}   ${ansi.gray}Tick:${ansi.reset} ${ansi.brightYellow}#${state.tickNumber}${ansi.reset}   ${ansi.gray}Refresh:${ansi.reset} ${ansi.white}${state.refreshIntervalMs / 1000}s${ansi.reset}`;
  const gap1 = Math.max(2, W - 4 - visibleWidth(titleLeft) - visibleWidth(uptimeStr));
  lines.push(boxRow(`${titleLeft}${" ".repeat(gap1)}${uptimeStr}`));

  const statsRow =
    `${ansi.gray}Spread:${ansi.reset} ${ansi.brightCyan}+/-${state.halfSpreadBps}bp${ansi.reset}  ` +
    `${ansi.gray}Drift:${ansi.reset} ${ansi.white}>=${state.requoteDriftBps}bp${ansi.reset}  ` +
    `${ansi.gray}Maker/Side:${ansi.reset} ${ansi.brightGreen}$${state.effectiveOrderSizeQuote}${ansi.reset}  ` +
    `${ansi.gray}Orders:${ansi.reset} ${ansi.white}${state.totalOrdersPlaced}${ansi.reset}  ` +
    `${ansi.gray}Maker Fills:${ansi.reset} ${ansi.brightGreen}${ansi.bold}${state.totalFillsDetected}${ansi.reset}  ` +
    `${ansi.gray}Daily Claim:${ansi.reset} ${state.dailyClaimStatus}`;
  lines.push(boxRow(statsRow));

  const elapsedHours = Math.max(0.002, (Date.now() - state.startedAtMs) / 3_600_000);
  const volPerHour = state.sessionVolumeUsd / elapsedHours;
  const nextVipTarget =
    state.totalVolumeUsd < 100_000
      ? { name: "VIP 1 ($100K)", target: 100_000 }
      : state.totalVolumeUsd < 500_000
        ? { name: "VIP 2 ($500K)", target: 500_000 }
        : { name: "VIP 3 ($1M)", target: 1_000_000 };
  const remainingVol = Math.max(0, nextVipTarget.target - state.totalVolumeUsd);
  const etaMins = volPerHour > 100 ? Math.ceil((remainingVol / volPerHour) * 60) : 0;
  const etaStr =
    etaMins > 0
      ? etaMins >= 60
        ? `~${Math.floor(etaMins / 60)}h ${etaMins % 60}m`
        : `~${etaMins}m`
      : "calculating...";

  const bal = state.balances;
  const portfolioRow =
    `${ansi.gray}Equity:${ansi.reset} ${ansi.bold}${ansi.brightGreen}~$${formatCompactNumber(bal.estimatedTotalEquityUsd, 2)}${ansi.reset} ` +
    `${ansi.gray}(Free: $${formatCompactNumber(bal.quoteAvailable, 0)} / Bids: $${formatCompactNumber(bal.quoteHeld, 0)})${ansi.reset}   ` +
    `${ansi.gray}Total Vol:${ansi.reset} ${ansi.bold}${ansi.brightYellow}$${formatCompactNumber(String(state.totalVolumeUsd), 2)}${ansi.reset}   ` +
    `${ansi.gray}Speed:${ansi.reset} ${ansi.brightCyan}~$${formatCompactNumber(String(volPerHour), 0)}/hr${ansi.reset}   ` +
    `${ansi.gray}${nextVipTarget.name}:${ansi.reset} ${ansi.white}${etaStr}${ansi.reset}`;
  lines.push(boxRow(portfolioRow));

  lines.push(midBorder);

  // Exact inner content width:
  // If multi-wallet rows are present: Wallet (8) | Pair (11) | Status (11) | Resting BID (20) | Mid Price (12) | Resting ASK (20) | Sprd (6) | Drift (7) | Base Inv (15) = 117
  // Single wallet: Pair (11) | Status (11) | Resting BID (22) | Mid Price (13) | Resting ASK (22) | Sprd (7) | Drift (8) | Base Inv (16) = 117
  const hasMultipleWallets = state.rows.some((r) => r.walletName);

  const cWal = 8;
  const cPair = hasMultipleWallets ? 10 : 11;
  const cStat = 11;
  const cBid = hasMultipleWallets ? 20 : 22;
  const cMid = hasMultipleWallets ? 12 : 13;
  const cAsk = hasMultipleWallets ? 20 : 22;
  const cSprd = hasMultipleWallets ? 6 : 7;
  const cDrift = hasMultipleWallets ? 7 : 8;
  const cInv = hasMultipleWallets ? 15 : 16;

  const headerLine = hasMultipleWallets
    ? `${ansi.bold}${ansi.white}` +
      `${padEndVisible("WALLET", cWal)} ` +
      `${padEndVisible("PAIR", cPair)} ` +
      `${padEndVisible("STATUS", cStat)} ` +
      `${padEndVisible("RESTING BID", cBid)} ` +
      `${padStartVisible("MID PRICE", cMid)} ` +
      `${padEndVisible("  RESTING ASK", cAsk)} ` +
      `${padStartVisible("SPREAD", cSprd)} ` +
      `${padStartVisible("DRIFT", cDrift)} ` +
      `${padStartVisible("BASE INV ($)", cInv)}` +
      `${ansi.reset}`
    : `${ansi.bold}${ansi.white}` +
      `${padEndVisible("PAIR", cPair)} ` +
      `${padEndVisible("STATUS", cStat)} ` +
      `${padEndVisible("RESTING BID (BUY)", cBid)} ` +
      `${padStartVisible("MID PRICE", cMid)} ` +
      `${padEndVisible("  RESTING ASK (SELL)", cAsk)} ` +
      `${padStartVisible("SPREAD", cSprd)} ` +
      `${padStartVisible("DRIFT", cDrift)} ` +
      `${padStartVisible("BASE INV ($)", cInv)}` +
      `${ansi.reset}`;
  lines.push(boxRow(headerLine));

  const sepLine = `${ansi.gray}${"─".repeat(W - 4)}${ansi.reset}`;
  lines.push(boxRow(sepLine));

  for (const r of state.rows) {
    const walCell = r.walletName ? `${ansi.bold}${ansi.cyan}${r.walletName}${ansi.reset}` : "";
    const pairCell = `${ansi.bold}${ansi.white}${r.pair}${ansi.reset}`;

    let statusCell = `${ansi.gray}  IDLE${ansi.reset}`;
    if (r.filledSinceLastTick && r.filledSinceLastTick.length > 0) {
      statusCell = `${ansi.brightGreen}${ansi.bold}* FILLED${ansi.reset}`;
    } else if (r.action === "HELD") {
      statusCell = `${ansi.green}* HOLDING${ansi.reset}`;
    } else if (r.action === "QUOTED") {
      if (r.bidOrderId && r.askOrderId) {
        statusCell = `${ansi.brightCyan}+ QUOTED${ansi.reset}`;
      } else {
        statusCell = `${ansi.yellow}~ 1-SIDED${ansi.reset}`;
      }
    } else if (r.action === "DRY_RUN") {
      statusCell = `${ansi.yellow}- DRY-RUN${ansi.reset}`;
    } else if (r.action === "SKIPPED") {
      statusCell = `${ansi.yellow}! SKIPPED${ansi.reset}`;
    } else if (r.action === "ERROR") {
      statusCell = `${ansi.brightRed}x ERROR${ansi.reset}`;
    }

    const bidCell = r.bidPrice
      ? `${ansi.brightGreen}${formatPrice(r.bidPrice)}${ansi.reset} ${ansi.gray}x ${formatCompactNumber(r.bidQty, 4)}${ansi.reset}`
      : `${ansi.gray}--${ansi.reset}`;

    const midCell = `${ansi.white}${formatPrice(r.midPrice)}${ansi.reset}`;

    const askCell = r.askPrice
      ? `  ${ansi.brightRed}${formatPrice(r.askPrice)}${ansi.reset} ${ansi.gray}x ${formatCompactNumber(r.askQty, 4)}${ansi.reset}`
      : `  ${ansi.gray}--${ansi.reset}`;

    const spreadCell =
      r.spreadBps !== undefined
        ? `${ansi.cyan}${r.spreadBps}bp${ansi.reset}`
        : `${ansi.gray}-${ansi.reset}`;

    const driftVal = r.driftBps ?? 0;
    const driftColor =
      driftVal >= r.requoteDriftBps
        ? ansi.brightYellow
        : driftVal >= Math.floor(r.requoteDriftBps * 0.7)
          ? ansi.yellow
          : ansi.gray;
    const driftCell = `${driftColor}${driftVal}/${r.requoteDriftBps}bp${ansi.reset}`;

    const invCell = `${ansi.white}${formatCompactNumber(r.baseBalanceTotal, 3)}${ansi.reset} ${ansi.gray}($${formatCompactNumber(r.baseValueUsd, 0)})${ansi.reset}`;

    const rowStr = hasMultipleWallets
      ? `${padEndVisible(walCell, cWal)} ` +
        `${padEndVisible(pairCell, cPair)} ` +
        `${padEndVisible(statusCell, cStat)} ` +
        `${padEndVisible(bidCell, cBid)} ` +
        `${padStartVisible(midCell, cMid)} ` +
        `${padEndVisible(askCell, cAsk)} ` +
        `${padStartVisible(spreadCell, cSprd)} ` +
        `${padStartVisible(driftCell, cDrift)} ` +
        `${padStartVisible(invCell, cInv)}`
      : `${padEndVisible(pairCell, cPair)} ` +
        `${padEndVisible(statusCell, cStat)} ` +
        `${padEndVisible(bidCell, cBid)} ` +
        `${padStartVisible(midCell, cMid)} ` +
        `${padEndVisible(askCell, cAsk)} ` +
        `${padStartVisible(spreadCell, cSprd)} ` +
        `${padStartVisible(driftCell, cDrift)} ` +
        `${padStartVisible(invCell, cInv)}`;

    lines.push(boxRow(rowStr));
  }

  lines.push(midBorder);
  lines.push(boxRow(`${ansi.bold}${ansi.white}RECENT MARKET MAKER EVENTS${ansi.reset}`));

  const events = state.recentEvents.length > 0 ? state.recentEvents : [`${ansi.gray}No special events yet - all two-sided quotes resting cleanly.${ansi.reset}`];
  for (const ev of events) {
    lines.push(boxRow(ev));
  }

  lines.push(botBorder);
  lines.push(
    `${ansi.gray}  Press ${ansi.white}Ctrl+C${ansi.gray} to cancel all resting limit orders & exit cleanly. Detailed logs: ${ansi.white}logs/bot-${new Date().toISOString().slice(0, 10)}.log${ansi.reset}`
  );

  process.stdout.write(lines.join("\n") + "\n");
}
