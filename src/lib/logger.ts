import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Timestamped console + daily file logger.
 * Never logs private keys, signatures, or bearer tokens.
 */

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const LOG_DIR = join(process.cwd(), "logs");

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore if already exists
  }
}

function getLogFilePath(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return join(LOG_DIR, `bot-${yyyy}-${mm}-${dd}.log`);
}

function formatLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const now = new Date();
  const ts = now.toISOString();
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `[${ts}] [${level.padEnd(5, " ")}] ${message}${metaStr}`;
}

function writeFileLog(line: string): void {
  try {
    ensureLogDir();
    appendFileSync(getLogFilePath(new Date()), `${line}\n`, "utf8");
  } catch {
    // Non-fatal if disk write fails
  }
}

function formatConsoleLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ts = `\x1b[90m${hh}:${mm}:${ss}\x1b[0m`;
  const metaStr = meta && Object.keys(meta).length > 0 ? ` \x1b[90m${JSON.stringify(meta)}\x1b[0m` : "";

  let levelTag = `\x1b[36m[INFO ]\x1b[0m`;
  if (level === "WARN") levelTag = `\x1b[33m[WARN ]\x1b[0m`;
  else if (level === "ERROR") levelTag = `\x1b[91m\x1b[1m[ERROR]\x1b[0m`;
  else if (level === "DEBUG") levelTag = `\x1b[90m[DEBUG]\x1b[0m`;

  return `${ts} ${levelTag} ${message}${metaStr}`;
}

function writeLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const fileLine = formatLine(level, message, meta);
  const consoleLine = formatConsoleLine(level, message, meta);
  if (level === "ERROR") {
    console.error(consoleLine);
  } else if (level === "WARN") {
    console.warn(consoleLine);
  } else {
    console.log(consoleLine);
  }

  writeFileLog(fileLine);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => writeLog("INFO", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => writeLog("WARN", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => writeLog("ERROR", message, meta),
  fileOnly: (level: LogLevel, message: string, meta?: Record<string, unknown>) =>
    writeFileLog(formatLine(level, message, meta)),
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.DEBUG === "true" || process.env.DEBUG === "1") {
      writeLog("DEBUG", message, meta);
    }
  },
};
