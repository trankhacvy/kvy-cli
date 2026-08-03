/**
 * JSONL transcript scanner: watches Claude Code's session transcript
 * file(s) for a working directory and emits each newly-appended, previously
 * unseen entry exactly once.
 *
 * behaviors are load-bearing and preserved verbatim:
 *
 *  - `processedEntryKeys`: a dedup set keyed on message identity, so a
 *    restart (which re-reads the whole file from byte 0) or an overlapping
 *    watcher tick never re-emits an entry already handed to `onMessage`.
 *  - `deadSessions`: once `fileWatcher`'s `onGaveUp` fires for a session
 *    (its transcript file never appeared), that session id is blacklisted
 *    forever. Without this, the periodic sync loop below would keep
 *    re-discovering the session (it's still in `pendingSessions` /
 *    `currentSessionId`) and re-creating a watcher for it every tick —
 *    which is exactly the CPU-spinning "dead instance" bug `fileWatcher.ts`
 *    was written to fix. The guard is what actually stops the bleeding at
 *    the scanner level.
 *
 * emits raw parsed JSONL entries via `onMessage`. Mapping those entries into
 * is a separate, later task and is intentionally not implemented here — nor
 * solely to feed that mapper.
 */

import { readFile, watch } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "../logger.js";
import { startFileWatcher } from "./fileWatcher.js";
import { type RawJSONLines, RawJSONLinesSchema } from "./types.js";

/**
 * Known internal Claude Code event types written to session JSONL files
 * that are not actual conversation messages — internal state/tracking
 * events silently skipped rather than surfaced or logged as errors.
 *
 * instead of maintaining a second copy that could silently drift from it.
 */
export const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
  "file-history-snapshot",
  "change",
  "queue-operation",
]);

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface SessionScannerOptions {
  /** The provider session id already known at startup, or null if none yet. */
  sessionId: string | null;
  workingDirectory: string;
  onMessage: (message: RawJSONLines) => void;
  /**
   * How long a session transcript may stay absent before its watcher gives
   * up and the session is dropped. Defaults to fileWatcher's default (60s).
   * Exposed mainly so tests can exercise the drop path quickly.
   */
  missingFileTimeoutMs?: number;
  /** How often to re-scan watched sessions' files for new entries. Defaults to 3s. */
  pollIntervalMs?: number;
  /**
   * How long the directory-wide rotation fallback (see
   * `watchProjectDirectoryForNewSessions`) stays armed after scanner start —
   * and again briefly after a tracked session is dropped — before it stops
   * trusting any new `*.jsonl` file it sees. Defaults to
   * `FALLBACK_ARMED_WINDOW_MS` (30s). Exposed mainly so tests can exercise the
   * expiry path quickly.
   */
  fallbackArmedWindowMs?: number;
  logger?: Logger;
  /** Overrides `process.env` for resolving `CLAUDE_CONFIG_DIR` (mainly for tests). */
  env?: NodeJS.ProcessEnv;
}

export interface SessionScanner {
  /** Stops all watchers and the periodic poll. Safe to call once. */
  cleanup: () => Promise<void>;
  /**
   * Forces one guaranteed-fresh read of every watched session's transcript
   * file, resolving only once it (and anything already in flight) has fully
   * completed — unlike the periodic poll, which fires on its own schedule
   * and returns nothing the caller can wait on. Needed by callers that must
   * know the transcript is fully ingested at a specific moment (e.g.
   * `ptyClaudeSession.ts`'s `closeTurn`, called from Claude Code's `Stop`
   * hook: the hook can fire before the periodic poll has ever read the
   * assistant's just-written message, so checking turn state without
   * flushing first races the poll and silently no-ops).
   */
  flush: () => Promise<void>;
  /**
   * Announce that Claude Code started (or resumed into) a new session id.
   * The previously-current session, if any, moves to `pendingSessions` so
   * it keeps being scanned (agent tasks can still append to it after a
   * `--resume`).
   *
   * @param options.treatExistingAsProcessed - pre-mark whatever is already
   * on disk for `sessionId` as processed, so the next sync does not replay
   * the entire existing transcript as "new" entries. Used on reconnect,
   * when the caller already has this history from a prior turn.
   */
  onNewSession: (
    sessionId: string,
    options?: { treatExistingAsProcessed?: boolean },
  ) => Promise<void>;
}

/** Resolves the Claude Code project transcript directory for a working directory. */
export function getProjectPath(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(claudeConfigDir, "projects", projectId);
}

function messageKey(message: RawJSONLines): string {
  if (message.type === "summary") {
    return `summary:${message.leafUuid}:${message.summary}`;
  }
  return message.uuid;
}

/**
 * Reads and parses a session transcript file, silently skipping internal
 * events, unparsable lines, and lines that don't match the known message
 * shapes — a missing file is not an error (the session may not have started
 * writing yet), it just yields no entries.
 */
async function readSessionEntries(
  projectDir: string,
  sessionId: string,
  logger: Logger,
): Promise<{ key: string; message: RawJSONLines }[]> {
  const file = join(projectDir, `${sessionId}.jsonl`);
  let contents: string;
  try {
    contents = await readFile(file, "utf-8");
  } catch (error) {
    const isMissing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    if (isMissing) {
      // Expected: the session may not have started writing yet.
      logger.debug("[SESSION_SCANNER] session file not found", { file });
    } else {
      // Anything other than "not there yet" (permission denied, I/O error,
      // path is a directory, etc.) is a real fault, not the expected
      // not-yet-started case — surface it at `warn` so it's visible without
      // KVY_DEBUG, even though we still degrade to "no entries" rather
      // than throwing (a transcript read must never crash the scanner).
      logger.warn("[SESSION_SCANNER] error reading session file", {
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return [];
  }

  const entries: { key: string; message: RawJSONLines }[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const raw = JSON.parse(line);
      if (raw?.type && INTERNAL_CLAUDE_EVENT_TYPES.has(raw.type)) continue;
      const parsed = RawJSONLinesSchema.safeParse(raw);
      if (!parsed.success) continue; // unknown message types are silently skipped
      entries.push({ key: messageKey(parsed.data), message: parsed.data });
    } catch (error) {
      logger.debug("[SESSION_SCANNER] error processing line", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return entries;
}

/**
 * How long to wait, after a new `*.jsonl` file appears in the project
 * directory, before treating it as a genuine rotation and calling
 * `SessionStart` hook doesn't fire (or its wiring is absent) — e.g. `/clear`
 * or a Claude-minted new id — so it deliberately waits a beat rather than
 * reacting to the bare `rename` event: a brand-new file can appear empty (or
 * with a partial first line) an instant before Claude Code finishes writing
 * its first entry, and debouncing lets that settle.
 */
const NEW_SESSION_ROTATION_DEBOUNCE_MS = 2000;

/**
 * How long the directory-wide rotation fallback trusts a newly-seen
 * `*.jsonl` file, measured from scanner start (and re-armed briefly after a
 * tracked session is dropped via `onGaveUp`). A bare `fs.watch` rename event
 * can never prove a new file belongs to *this* scanner's own child process —
 * it's only a reasonable signal right around when a rotation would actually
 * be expected, not for the entire lifetime of a long-running session
 * — the fallback's authority is time-boxed even in the no-hook case.
 */
const FALLBACK_ARMED_WINDOW_MS = 30_000;

/**
 * Watches a Claude Code project transcript directory for newly-created
 * `*.jsonl` files, calling `onNewFile` with each one's session id (the
 * filename minus extension) — debounced per id so a burst of `rename`
 * events for the same file collapses into one call. Retries indefinitely
 * with capped exponential backoff on any watch error (including the
 * directory not existing yet, e.g. a session whose transcript directory
 * Claude Code hasn't created yet) — unlike `fileWatcher.ts`'s
 * `startFileWatcher`, there is no give-up: this watcher is meant to outlive
 * the whole session, and the directory will exist by the time any session
 * writes its first transcript entry. Its *authority* to adopt what it sees is
 * bounded by the caller, though (see `hookConfirmed` / `fallbackArmedUntil` in
 * `createSessionScanner`) — this function itself has no opinion on that, it
 * only reports raw new-file sightings.
 */
function watchProjectDirectoryForNewSessions(
  projectDir: string,
  onNewFile: (sessionId: string) => void,
  logger: Logger,
): () => void {
  const abortController = new AbortController();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
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
    let failureCount = 0;
    for (;;) {
      if (abortController.signal.aborted) return;
      try {
        const watcher = watch(projectDir, { persistent: true, signal: abortController.signal });
        failureCount = 0;
        for await (const event of watcher) {
          if (abortController.signal.aborted) return;
          const fileName = event.filename;
          if (!fileName?.endsWith(".jsonl")) continue;
          const sessionId = fileName.slice(0, -".jsonl".length);
          if (!sessionId) continue;

          const existing = debounceTimers.get(sessionId);
          if (existing) clearTimeout(existing);
          debounceTimers.set(
            sessionId,
            setTimeout(() => {
              debounceTimers.delete(sessionId);
              onNewFile(sessionId);
            }, NEW_SESSION_ROTATION_DEBOUNCE_MS),
          );
        }
        // Iterator ended without an abort (rare); fall through to retry.
      } catch (error) {
        if (abortController.signal.aborted) return;
        failureCount++;
        const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
        logger.debug("[SESSION_SCANNER] project directory watch error, retrying", {
          projectDir,
          message: error instanceof Error ? error.message : String(error),
          backoffMs,
        });
        await wait(backoffMs);
      }
    }
  })();

  return () => {
    abortController.abort();
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
  };
}

export async function createSessionScanner(opts: SessionScannerOptions): Promise<SessionScanner> {
  const logger = opts.logger ?? noopLogger;
  const projectDir = getProjectPath(opts.workingDirectory, opts.env ?? process.env);
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const fallbackArmedWindowMs = opts.fallbackArmedWindowMs ?? FALLBACK_ARMED_WINDOW_MS;

  const finishedSessions = new Set<string>();
  const pendingSessions = new Set<string>();
  const watchers = new Map<string, () => void>();
  const processedEntryKeys = new Set<string>();
  // Sessions whose transcript file never appeared: their watcher gave up,
  // so they must never be re-collected or re-watched (see file header).
  const deadSessions = new Set<string>();
  let currentSessionId: string | null = null;
  // Whether a `SessionStart` hook has ever confirmed this scanner's own
  // session id via the public `onNewSession` entry point (seeded true when
  // the caller already knows a real session id at construction — that also
  // came from an authoritative source, not the directory-wide heuristic
  // below). Once true, the directory-wide fallback below is never trusted
  // again for a *different* file.
  let hookConfirmed = opts.sessionId !== null;
  // The directory-wide rotation fallback's authority is also time-boxed:
  // armed for `fallbackArmedWindowMs` from
  // scanner start, and re-armed briefly whenever a tracked session is
  // dropped (`onGaveUp`, below) — never for the scanner's entire lifetime.
  let fallbackArmedUntil = Date.now() + fallbackArmedWindowMs;

  if (opts.sessionId) {
    const entries = await readSessionEntries(projectDir, opts.sessionId, logger);
    for (const entry of entries) processedEntryKeys.add(entry.key);
    currentSessionId = opts.sessionId;
  }

  // --- Minimal coalescing re-entrancy guard around `runSync` ---
  // sync is already running are coalesced into exactly one more run after
  // the current one finishes, instead of queuing unboundedly or running
  // concurrently (readSessionEntries + watcher bookkeeping is not safe to
  // run twice at once against the same mutable sets).
  let running = false;
  let rerunRequested = false;
  let stopped = false;
  // Tracks the in-flight `runSyncCoalesced()` call (if any) so `cleanup()`
  // can await it before running its own final pass, rather than racing a
  // concurrent `readSessionEntries`/watcher-bookkeeping run (see the
  // coalescing guard's own doc comment above).
  let currentSyncPromise: Promise<void> | null = null;

  async function runSync(): Promise<void> {
    // Collect every session id worth scanning this tick: pending sessions
    // (superseded by --resume but possibly still being appended to),
    // the current session, and anything that already has a live watcher —
    // all minus anything blacklisted as dead.
    const sessions: string[] = [];
    for (const id of pendingSessions) {
      if (!deadSessions.has(id)) sessions.push(id);
    }
    if (
      currentSessionId &&
      !pendingSessions.has(currentSessionId) &&
      !deadSessions.has(currentSessionId)
    ) {
      sessions.push(currentSessionId);
    }
    for (const id of watchers.keys()) {
      if (!sessions.includes(id) && !deadSessions.has(id)) sessions.push(id);
    }

    for (const sessionId of sessions) {
      const entries = await readSessionEntries(projectDir, sessionId, logger);
      for (const entry of entries) {
        if (processedEntryKeys.has(entry.key)) continue;
        processedEntryKeys.add(entry.key);
        opts.onMessage(entry.message);
      }
    }

    for (const id of sessions) {
      if (pendingSessions.has(id)) {
        pendingSessions.delete(id);
        finishedSessions.add(id);
      }
    }

    for (const id of sessions) {
      if (watchers.has(id) || deadSessions.has(id)) continue;
      logger.debug("[SESSION_SCANNER] starting watcher", { sessionId: id });
      watchers.set(
        id,
        startFileWatcher(join(projectDir, `${id}.jsonl`), () => invalidate(), {
          missingFileTimeoutMs: opts.missingFileTimeoutMs,
          logger,
          onGaveUp: () => {
            // The transcript for this session never appeared. Tear the
            // watcher down and blacklist the session so the collection
            // loop above stops resurrecting it — otherwise this phantom
            // session id would keep itself in `watchers` forever and this
            // callback would fire repeatedly as the poll interval ticks.
            logger.debug("[SESSION_SCANNER] session transcript never appeared — dropping", {
              sessionId: id,
            });
            watchers.get(id)?.();
            watchers.delete(id);
            deadSessions.add(id);
            pendingSessions.delete(id);
            // A rotation is plausible right after a drop (e.g. the dropped
            // id's own process was slow, and a real replacement is about to
            // show up) — briefly re-arm the fallback's authority rather than
            // leaving it expired for the rest of the session.
            fallbackArmedUntil = Date.now() + fallbackArmedWindowMs;
          },
        }),
      );
    }
  }

  async function runSyncCoalesced(): Promise<void> {
    if (stopped) return;
    try {
      await runSync();
    } catch (error) {
      logger.error("[SESSION_SCANNER] sync pass failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (rerunRequested && !stopped) {
      rerunRequested = false;
      await runSyncCoalesced();
      return;
    }
    running = false;
  }

  function invalidate(): void {
    if (stopped) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    currentSyncPromise = runSyncCoalesced();
  }

  /**
   * `flush`'s implementation: always routes through the same
   * `running`/`currentSyncPromise` guard `invalidate()` uses — `runSync`'s
   * mutable state (`processedEntryKeys`, `watchers`, etc.) isn't safe to
   * re-enter concurrently, so this never calls `runSync()` directly while a
   * periodic-poll-triggered pass could still be in flight.
   */
  async function flush(): Promise<void> {
    if (stopped) return;
    // Wait out whatever's currently running, re-requesting a rerun each time
    // in case our request loses the race with an in-flight pass's own
    // rerunRequested check — once the loop exits, nothing is running.
    while (running) {
      rerunRequested = true;
      await currentSyncPromise?.catch(() => {});
    }
    // Run one guaranteed-fresh pass ourselves so the transcript is fully
    // ingested by the time this resolves, regardless of the poll interval.
    running = true;
    currentSyncPromise = runSyncCoalesced();
    await currentSyncPromise.catch(() => {});
  }

  /**
   * The shared body of `onNewSession` — also called by the directory-rotation
   * fallback below, so both the caller-driven path (a `SessionStart` hook)
   * and the fallback path (no hook fired) go through identical dedup/pending
   * bookkeeping. `source` distinguishes the two: only `"hook"` (the
   * caller-driven, authoritative path) may revive a previously-dropped
   * (`deadSessions`) id — a `"fallback"`-sourced call has zero actual
   * correlation to "this is my own process rotating," it's purely "a file
   * with some other name appeared in a directory I'm also watching," so it
   * must never resurrect a session it can't independently verify.
   */
  async function announceNewSession(
    sessionId: string,
    options?: { treatExistingAsProcessed?: boolean },
    source: "hook" | "fallback" = "hook",
  ): Promise<void> {
    if (currentSessionId === sessionId) {
      logger.debug("[SESSION_SCANNER] new session is already current, skipping", { sessionId });
      return;
    }
    // The caller explicitly re-announces this session, so give a
    // previously-dropped id another chance (its file may exist now). Only
    // the hook path is trusted to do this — see the doc comment above.
    if (source === "hook" && deadSessions.delete(sessionId)) {
      logger.debug("[SESSION_SCANNER] reviving previously-dropped session", { sessionId });
    }
    if (finishedSessions.has(sessionId)) {
      logger.debug("[SESSION_SCANNER] new session already finished, skipping", { sessionId });
      return;
    }
    if (pendingSessions.has(sessionId)) {
      logger.debug("[SESSION_SCANNER] new session already pending, skipping", { sessionId });
      return;
    }
    // When the caller already has these messages (e.g. reconnect, where
    // the server holds history from prior turns), pre-mark whatever is
    // on disk so the first sync does not replay the whole file as fresh
    // messages.
    if (options?.treatExistingAsProcessed) {
      const existing = await readSessionEntries(projectDir, sessionId, logger);
      for (const entry of existing) processedEntryKeys.add(entry.key);
    }
    if (currentSessionId) pendingSessions.add(currentSessionId);
    currentSessionId = sessionId;
    invalidate();
  }

  await runSync();
  const intervalId = setInterval(invalidate, pollIntervalMs);

  // the project directory whose id differs from the current session — e.g.
  // `/clear` or a Claude-minted new id — is a strong signal the session
  // rotated even when no `SessionStart` hook fired to announce it via
  // `onNewSession` directly. Hook coverage is the primary path; this only
  // fires when it didn't, hence the debounce + explicit log. Its authority
  // is bounded two ways: it stops being trusted at all
  // once a hook has ever confirmed this scanner's own session id
  // (`hookConfirmed`), and even before that it's only armed for a bounded
  // window (`fallbackArmedUntil`), not the scanner's entire lifetime.
  const stopDirectoryWatcher = watchProjectDirectoryForNewSessions(
    projectDir,
    (newSessionId) => {
      if (stopped) return;
      if (newSessionId === currentSessionId) return;
      if (Date.now() > fallbackArmedUntil) {
        logger.debug("[SESSION_SCANNER] ignoring new transcript file — fallback window expired", {
          newSessionId,
        });
        return;
      }
      if (hookConfirmed) {
        // A hook has already proven this scanner has real SessionStart
        // coverage — a *different* file appearing is almost certainly a
        // sibling session sharing this directory, not our own rotation.
        logger.debug(
          "[SESSION_SCANNER] ignoring unrelated new transcript file (hook coverage active)",
          { newSessionId, currentSessionId },
        );
        return;
      }
      logger.info(
        "[SESSION_SCANNER] new transcript file detected — rotating session (fallback, no hook coverage)",
        { newSessionId, previousSessionId: currentSessionId },
      );
      void announceNewSession(newSessionId, undefined, "fallback");
    },
    logger,
  );

  return {
    cleanup: async () => {
      stopped = true;
      clearInterval(intervalId);
      stopDirectoryWatcher();
      // Let any in-flight sync settle, then run one final pass ourselves —
      // the same body the periodic interval runs — so entries appended in
      // the brief window right before shutdown (the "shutdown tail") are
      if (currentSyncPromise) await currentSyncPromise.catch(() => {});
      try {
        await runSync();
      } catch (error) {
        logger.error("[SESSION_SCANNER] final sync pass failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
    flush,
    onNewSession: async (sessionId, options) => {
      hookConfirmed = true;
      await announceNewSession(sessionId, options, "hook");
    },
  };
}
