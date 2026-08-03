/**
 * Shared log-file naming for the Setup/Run scripts subsystem: both
 * `setupScript.ts` (setup-script runs) and `runProcess.ts` (the long-lived `run.*` process)
 * write their child's stdout/stderr into a single, fresh-truncated log file
 * per directory — `setupLogFilePath`/`runLogFilePath` below are the one
 * place that naming is decided, so both modules (and `run.status`'s
 * `logTail` read) agree on exactly where to find it.
 *
 * Named by a short hash of the directory key rather than the raw path
 * itself — a worktree path can contain characters that are awkward in a
 * filename (spaces, unicode) and can be arbitrarily long; the hash sidesteps
 * both without needing a second lookup table.
 */
import { createHash } from "node:crypto";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** First 12 hex chars of `sha256(directoryKey)` — short enough for a filename/tmux session name, long enough that two distinct real directories never collide in practice. */
export function directoryHash(directoryKey: string): string {
  return createHash("sha256").update(directoryKey).digest("hex").slice(0, 12);
}

export function setupLogFilePath(homeDir: string, directoryKey: string): string {
  return path.join(homeDir, "logs", `setup-${directoryHash(directoryKey)}.log`);
}

export function runLogFilePath(homeDir: string, directoryKey: string): string {
  return path.join(homeDir, "logs", `run-${directoryHash(directoryKey)}.log`);
}

/** Creates (or truncates) `logFile` empty, so a re-run's log never leaks a previous run's output — shared by `setupScript.ts` and `runProcess.ts`. */
export async function createFreshLogFile(logFile: string): Promise<void> {
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, "", "utf8");
}

/** Reads the last `maxBytes` of `logFile` (default 4KB), or `undefined` when the file doesn't exist (nothing has run yet) — tolerant of any read failure, never throws. */
export async function readLogTail(logFile: string, maxBytes = 4096): Promise<string | undefined> {
  try {
    const stats = await stat(logFile);
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    if (length <= 0) return "";
    const handle = await open(logFile, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
