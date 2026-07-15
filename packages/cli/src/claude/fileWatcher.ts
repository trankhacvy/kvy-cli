/**
 * Watch a single file for changes, with a bounded give-up path for files
 * that never appear.
 *
 * Ported verbatim (behavior-for-behavior) from
 * happy-cli/src/modules/watcher/startFileWatcher.ts (MIT). `fs.watch()`
 * throws `ENOENT` synchronously for a path that does not exist, so a naive
 * "watch in a tight retry loop" turns a session whose transcript file never
 * gets created (e.g. a phantom/dead provider instance) into an infinite,
 * CPU-spinning, log-flooding retry loop — the "dead Happy instance" bug this
 * function exists to prevent (see scanner.ts's `deadSessions` guard, which
 * is the other half of the fix).
 *
 * This implementation:
 *  - backs off exponentially between retries (1s → 15s, capped),
 *  - distinguishes "file absent" (ENOENT) from transient watch errors,
 *  - gives up — instead of spinning forever — once the file has stayed
 *    absent past `missingFileTimeoutMs`, signalling the caller via
 *    `onGaveUp` so it can stop re-creating this watcher,
 *  - resets all failure state as soon as the file is observed, so a slow
 *    session start that eventually writes its transcript heals cleanly.
 */

import { watch } from "node:fs/promises";
import type { Logger } from "../logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface FileWatcherOptions {
  /**
   * Invoked exactly once when the watcher permanently gives up because the
   * target file never appeared within `missingFileTimeoutMs`. The watch
   * loop exits right after; the caller owns any follow-up cleanup (e.g.
   * dropping the dead session so it is never re-watched).
   */
  onGaveUp?: () => void;
  /**
   * How long the file may stay continuously absent before we give up.
   * Defaults to 60s — comfortably longer than a legitimately slow session
   * start, but bounded so a session id that never produces a file cannot
   * wedge the process.
   */
  missingFileTimeoutMs?: number;
  logger?: Logger;
}

/** Returns a disposer that stops the watcher (safe to call more than once). */
export function startFileWatcher(
  file: string,
  onFileChange: (file: string) => void,
  options: FileWatcherOptions = {},
): () => void {
  const abortController = new AbortController();
  const missingFileTimeoutMs = options.missingFileTimeoutMs ?? 60_000;
  const logger = options.logger ?? noopLogger;

  // Timeout/abort-aware wait so a long backoff does not delay cleanup.
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (abortController.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortController.signal.addEventListener("abort", onAbort, { once: true });
    });

  void (async () => {
    // When the target file first went missing (null = currently present or
    // never-yet-missing). Used to bound total absence time.
    let missingSince: number | null = null;
    let failureCount = 0;

    for (;;) {
      try {
        logger.debug(`[FILE_WATCHER] starting watcher`, { file });
        const watcher = watch(file, { persistent: true, signal: abortController.signal });
        for await (const _event of watcher) {
          if (abortController.signal.aborted) return;
          missingSince = null;
          failureCount = 0;
          logger.debug(`[FILE_WATCHER] file changed`, { file });
          onFileChange(file);
        }
        // Iterator ended without an abort (rare); fall through to retry.
      } catch (error) {
        if (abortController.signal.aborted) return;

        const isMissing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
        if (isMissing) {
          const now = Date.now();
          if (missingSince === null) missingSince = now;
          const absentMs = now - missingSince;
          if (absentMs >= missingFileTimeoutMs) {
            logger.debug(`[FILE_WATCHER] giving up: file never appeared`, {
              file,
              absentMs,
            });
            options.onGaveUp?.();
            return;
          }
        } else {
          // Transient error on an (assumed) existing file: back off and
          // keep retrying, but do not count it as "missing".
          missingSince = null;
        }

        failureCount++;
        const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`[FILE_WATCHER] watch error, retrying`, { file, message, backoffMs });
        await wait(backoffMs);
      }
    }
  })();

  return () => {
    abortController.abort();
  };
}
