/**
 * JSONL transcript scanner: watches Claude Code's session transcript
 * file(s) for a working directory and emits each newly-appended, previously
 * unseen entry exactly once.
 *
 * Ported from happy-cli/src/claude/utils/sessionScanner.ts (MIT). Two
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
 * ⚠ Scope note (plan.md §16, "1.4 Transcript pipeline"): this port only
 * emits raw parsed JSONL entries via `onMessage`. Mapping those entries into
 * wire envelopes (`mapClaudeToEnvelopes` / Happy's `sessionProtocolMapper`)
 * is a separate, later task and is intentionally not implemented here — nor
 * is Happy's `deadGoalStatusTranscriptEvent` side channel, which exists
 * solely to feed that mapper.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "../logger.js";
import { startFileWatcher } from "./fileWatcher.js";
import { type RawJSONLines, RawJSONLinesSchema } from "./types.js";

/**
 * Known internal Claude Code event types written to session JSONL files
 * that are not actual conversation messages — internal state/tracking
 * events silently skipped rather than surfaced or logged as errors.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set(["file-history-snapshot", "change", "queue-operation"]);

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
  logger?: Logger;
  /** Overrides `process.env` for resolving `CLAUDE_CONFIG_DIR` (mainly for tests). */
  env?: NodeJS.ProcessEnv;
}

export interface SessionScanner {
  /** Stops all watchers and the periodic poll. Safe to call once. */
  cleanup: () => Promise<void>;
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
      // FALCON_DEBUG, even though we still degrade to "no entries" rather
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

export async function createSessionScanner(opts: SessionScannerOptions): Promise<SessionScanner> {
  const logger = opts.logger ?? noopLogger;
  const projectDir = getProjectPath(opts.workingDirectory, opts.env ?? process.env);
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;

  const finishedSessions = new Set<string>();
  const pendingSessions = new Set<string>();
  const watchers = new Map<string, () => void>();
  const processedEntryKeys = new Set<string>();
  // Sessions whose transcript file never appeared: their watcher gave up,
  // so they must never be re-collected or re-watched (see file header).
  const deadSessions = new Set<string>();
  let currentSessionId: string | null = null;

  if (opts.sessionId) {
    const entries = await readSessionEntries(projectDir, opts.sessionId, logger);
    for (const entry of entries) processedEntryKeys.add(entry.key);
    currentSessionId = opts.sessionId;
  }

  // --- Minimal coalescing re-entrancy guard around `runSync` ---
  // Mirrors happy-cli's InvalidateSync: `invalidate()` calls made while a
  // sync is already running are coalesced into exactly one more run after
  // the current one finishes, instead of queuing unboundedly or running
  // concurrently (readSessionEntries + watcher bookkeeping is not safe to
  // run twice at once against the same mutable sets).
  let running = false;
  let rerunRequested = false;
  let stopped = false;

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
    void runSyncCoalesced();
  }

  await runSync();
  const intervalId = setInterval(invalidate, pollIntervalMs);

  return {
    cleanup: async () => {
      stopped = true;
      clearInterval(intervalId);
      for (const stop of watchers.values()) stop();
      watchers.clear();
    },
    onNewSession: async (sessionId, options) => {
      if (currentSessionId === sessionId) {
        logger.debug("[SESSION_SCANNER] new session is already current, skipping", { sessionId });
        return;
      }
      // The caller explicitly re-announces this session, so give a
      // previously-dropped id another chance (its file may exist now).
      if (deadSessions.delete(sessionId)) {
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
    },
  };
}
