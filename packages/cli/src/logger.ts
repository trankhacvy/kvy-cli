import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "./home.js";

/**
 * File-only logger.
 *
 * This module MUST NEVER write to stdout/stderr. Once local-mode session
 * spawning lands (plan.md §6.3), the kvy process inherits its stdio
 * (`stdio: ['inherit','inherit','inherit','pipe']`) into the real Claude
 * Code / Codex child process — any stray write from Kvy on those file
 * descriptors would land inside the provider's TUI and corrupt its
 * rendering. So all internal diagnostics go to `~/.kvy/logs/` instead.
 *
 * This is distinct from ordinary CLI output (help text, `--version`, error
 * messages) — those are legitimate user-facing writes to stdout/stderr made
 * directly by command handlers, not logging, and are unaffected by this
 * rule (design §7.2: "logs/ … file-only logging; NEVER stdout").
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  /** Overrides the resolved `~/.kvy` (or `KVY_HOME_DIR`) directory. */
  homeDir?: string;
  /** Overrides KVY_DEBUG-derived level gating. */
  debug?: boolean;
  env?: NodeJS.ProcessEnv;
}

function logFilePath(homeDir: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD — one file per day
  return path.join(homeDir, "logs", `kvy-${stamp}.log`);
}

function formatLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
  return `${JSON.stringify(entry)}\n`;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? resolveHomeDir(env);
  const minLevel: LogLevel = (options.debug ?? env.KVY_DEBUG === "1") ? "debug" : "info";
  let logsDirEnsured = false;

  function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    // Best-effort: logging is a diagnostic side channel, never load-bearing
    // for the CLI's actual behavior. A permission error, read-only/missing
    // home dir, full disk, or non-serializable `meta` must never crash the
    // primary command (e.g. `kvy --help`) — swallow and move on instead
    // of throwing out of `main()`.
    try {
      const logsDir = path.join(homeDir, "logs");
      if (!logsDirEnsured) {
        mkdirSync(logsDir, { recursive: true });
        logsDirEnsured = true;
      }

      // Synchronous, blocking append: CLI invocations are short-lived and log
      // volume is low, so a blocking write is simpler and safer than buffering
      // lines that could be lost on an abrupt exit (e.g. SIGTERM mid-handoff).
      appendFileSync(logFilePath(homeDir, new Date()), formatLine(level, message, meta));
    } catch {
      // Nothing we can safely do with a broken diagnostics channel — the
      // whole point of this module is that it must never surface upward.
    }
  }

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
