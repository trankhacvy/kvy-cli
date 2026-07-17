/**
 * Transcript indexer — adoption Tier 1 (plan.md §16 "3.3 Session adoption
 * (UC9)", falcon-system-design.md §8 "Transcript indexer (adoption Tier
 * 1)" / §11 "Session adoption — UC9"): fs-watches every registered
 * workspace's Claude Code project transcript directory
 * (`../claude/scanner.js`'s `getProjectPath`) and upserts an
 * `unmanagedSessions` row (via `unmanagedSessionClient.ts`) for every
 * session transcript found there, debounced 2s so a burst of appends during
 * one active turn produces one upsert, not dozens. Liveness ("is this
 * specific transcript's session still running?") is a best-effort signal
 * derived from `processScan.ts` + `markers.ts` — a plain `claude` process
 * (never a Falcon-managed one) whose cwd resolves to the workspace path,
 * matched against whichever transcript file in that workspace was most
 * recently modified.
 *
 * New code (N) — no direct Happy equivalent (Happy's `sessionScanner.ts`
 * this borrows `getProjectPath` from watches a *specific* session id
 * already known to a running `falcon claude` process; this watches an
 * entire *directory* for sessions Falcon never started).
 *
 * Scope note: this module only owns discovery + upsert. Two seams are
 * intentionally left to later, not-yet-built work rather than stubbed out
 * half-finished here:
 *
 *  - `listWorkspaces` has no real default (mirrors `bootstrap.ts`'s
 *    `getAuthToken`) — nothing in the codebase yet persists "which
 *    workspace paths are registered" (that bookkeeping belongs to the
 *    spawn-RPC task, plan.md §16 "3.1 Remote spawn", which is what actually
 *    knows a workspace's path/id at the point a session is spawned into
 *    it). Callers must supply it.
 *  - `isManaged` (skip a `providerRef` that's actually a Falcon-managed
 *    session's lineage) defaults to "nothing is managed yet" — the
 *    lineage store it would consult (`providerSessionLineage`) is built by
 *    the *other* half of §3.3 (`adopt.take` + `falcon adopt`), explicitly
 *    out of scope for this task.
 */
import { readdir, readFile, stat, watch } from "node:fs/promises";
import path, { resolve as resolvePath } from "node:path";
import { getProjectPath } from "../claude/scanner.js";
import type { Logger } from "../logger.js";
import { classifyFalconCommand } from "./markers.js";
import {
  listProcesses as listProcessesDefault,
  type ProcessEntry,
  resolveProcessCwd as resolveProcessCwdDefault,
} from "./processScan.js";
import type { UpsertUnmanagedSessionParams } from "./unmanagedSessionClient.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const JSONL_EXT = ".jsonl";
const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_RESCAN_WORKSPACES_MS = 30_000;

export interface RegisteredWorkspace {
  workspaceId: string;
  /** Absolute working-directory path Claude Code was/would be run in. */
  path: string;
}

export interface TranscriptIndexerDeps {
  machineId: string;
  /** Workspaces to watch. Called once at start, and again every `rescanWorkspacesMs` so newly-registered workspaces are picked up without a restart. */
  listWorkspaces: () => Promise<RegisteredWorkspace[]>;
  /** Persists one unmanaged-session row. Failures must be handled internally (logged), never thrown — see `unmanagedSessionClient.ts`'s own contract. */
  upsert: (params: UpsertUnmanagedSessionParams) => Promise<boolean>;
  /** True if `providerRef` is already known to be a Falcon-managed session (lineage lookup) and should never be surfaced as unmanaged. */
  isManaged: (providerRef: string) => boolean | Promise<boolean>;
  listProcesses: () => Promise<ProcessEntry[]>;
  resolveProcessCwd: (pid: number) => Promise<string | null>;
  /** How long to wait after the last change to a given transcript file before indexing it. */
  debounceMs: number;
  /** How often to re-call `listWorkspaces()` and start watchers for anything new. */
  rescanWorkspacesMs: number;
  logger: Logger;
  env: NodeJS.ProcessEnv;
}

export function createTranscriptIndexerDeps(
  required: Pick<TranscriptIndexerDeps, "machineId" | "listWorkspaces" | "upsert">,
  overrides: Partial<TranscriptIndexerDeps> = {},
): TranscriptIndexerDeps {
  return {
    isManaged: () => false,
    listProcesses: listProcessesDefault,
    resolveProcessCwd: resolveProcessCwdDefault,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    rescanWorkspacesMs: DEFAULT_RESCAN_WORKSPACES_MS,
    logger: noopLogger,
    env: process.env,
    ...required,
    ...overrides,
  };
}

export interface TranscriptIndexerHandle {
  /** Stops every directory watcher, pending debounce timer, and the rescan loop. Safe to call once. */
  stop: () => void;
}

/** A single parsed transcript's index-worthy facts, or `null` for an empty/unwritten file. */
interface ParsedTranscript {
  title: string;
  lastActivity: number;
}

const MAX_TITLE_LENGTH = 120;

function truncateTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE_LENGTH ? `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : oneLine;
}

/** Extracts the first non-empty `text` block from a Claude Code `message.content` field (string or block array). */
function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        const text = ((block as Record<string, unknown>).text as string).trim();
        if (text) return text;
      }
    }
  }
  return null;
}

/**
 * Parses a Claude Code JSONL transcript into title + last-activity facts.
 * Unparsable/unrecognized lines are silently skipped (same tolerance as
 * `scanner.ts`'s reader) — a transcript is written incrementally by a live
 * process, so a line caught mid-write is expected, not an error. Returns
 * `null` only when the file has no usable entries at all (freshly created,
 * still empty).
 *
 * Title preference: Claude Code's own generated `{"type":"summary",...}`
 * line (the most human-readable signal available) if one exists anywhere in
 * the file, else the first user message's text, else a generic fallback —
 * never `null`/empty (no silent failures: every indexed session gets a
 * presentable title).
 */
export function parseTranscript(contents: string): ParsedTranscript | null {
  let sawAnyEntry = false;
  let summaryTitle: string | null = null;
  let firstUserText: string | null = null;
  let lastActivity = 0;

  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    sawAnyEntry = true;
    const entry = raw as Record<string, unknown>;

    if (typeof entry.timestamp === "string") {
      const ms = Date.parse(entry.timestamp);
      if (!Number.isNaN(ms) && ms > lastActivity) lastActivity = ms;
    }

    if (entry.type === "summary" && typeof entry.summary === "string" && entry.summary.trim()) {
      summaryTitle = entry.summary.trim();
    } else if (entry.type === "user" && !firstUserText) {
      const message = entry.message as Record<string, unknown> | undefined;
      const text = message ? extractText(message.content) : null;
      if (text) firstUserText = text;
    }
  }

  if (!sawAnyEntry) return null;
  const title = summaryTitle ?? (firstUserText ? truncateTitle(firstUserText) : "Untitled session");
  return { title, lastActivity };
}

/** True for a bare `claude` invocation's command line — false for anything Falcon itself launched (`falcon claude ...`), so a managed session's own process is never mistaken for an unmanaged one. */
function isPlainClaudeCommand(command: string): boolean {
  if (classifyFalconCommand(command)) return false;
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const first = tokens[0];
  if (!first) return false;
  const base = first.split("/").pop() ?? first;
  return base === "claude";
}

/**
 * Best-effort "is *some* live, non-Falcon `claude` process's cwd this
 * workspace, and is `sessionId` the most-recently-modified transcript in it"
 * check. Both conditions are required: a live process alone doesn't tell
 * you *which* transcript in a workspace directory (which may hold many
 * historical sessions) it's writing to, so this treats the newest file as
 * the one that process owns.
 */
async function computeRunning(
  projectDir: string,
  sessionId: string,
  workspacePath: string,
  deps: Pick<TranscriptIndexerDeps, "listProcesses" | "resolveProcessCwd">,
): Promise<boolean> {
  const resolvedWorkspace = resolvePath(workspacePath);
  const processes = await deps.listProcesses();

  let liveMatch = false;
  for (const proc of processes) {
    if (!isPlainClaudeCommand(proc.command)) continue;
    const cwd = await deps.resolveProcessCwd(proc.pid);
    if (cwd && resolvePath(cwd) === resolvedWorkspace) {
      liveMatch = true;
      break;
    }
  }
  if (!liveMatch) return false;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return false;
  }

  let latestId: string | null = null;
  let latestMtimeMs = -Infinity;
  for (const name of entries) {
    if (!name.endsWith(JSONL_EXT)) continue;
    try {
      const stats = await stat(path.join(projectDir, name));
      if (stats.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stats.mtimeMs;
        latestId = name.slice(0, -JSONL_EXT.length);
      }
    } catch {
      // Raced with a delete/rename between readdir and stat — skip it.
    }
  }
  return latestId === sessionId;
}

/**
 * Watches a directory forever, retrying with capped exponential backoff on
 * any error (including the directory not existing yet — a registered
 * workspace may not have a Claude Code project dir until the first session
 * runs there). Unlike `../claude/fileWatcher.ts`'s per-session file
 * watcher, this never gives up: a registered workspace stays watched for
 * the indexer's whole lifetime, however long its transcript dir takes to
 * appear.
 */
function watchDirectoryForever(
  dir: string,
  onEvent: (filename: string | null) => void,
  logger: Logger,
  /**
   * Invoked right before every attempt to attach the watcher — the first
   * one and every retry after a backoff. A retry means the directory may
   * have just come into existence (or been re-created) since the last
   * attempt, and `fs.watch` never replays history: anything written
   * between "directory appeared" and "watcher successfully attached" would
   * otherwise be silently missed. The caller uses this hook to re-run its
   * own readdir-based catch-up scan right before each attach, closing that
   * window down to the (much smaller) gap between this call and the
   * `watch()` call two lines below.
   */
  onReady?: () => void,
): () => void {
  const abortController = new AbortController();

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
    let failureCount = 0;
    for (;;) {
      if (abortController.signal.aborted) return;
      try {
        onReady?.();
        const watcher = watch(dir, { persistent: true, signal: abortController.signal });
        failureCount = 0;
        for await (const event of watcher) {
          if (abortController.signal.aborted) return;
          onEvent(event.filename ? event.filename.toString() : null);
        }
        return; // iterator ended without an abort (rare) — nothing more to watch
      } catch (error) {
        if (abortController.signal.aborted) return;
        failureCount++;
        const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
        logger.debug("[transcript-indexer] directory watch error, retrying", {
          dir,
          backoffMs,
          message: error instanceof Error ? error.message : String(error),
        });
        await wait(backoffMs);
      }
    }
  })();

  return () => abortController.abort();
}

export function startTranscriptIndexer(deps: TranscriptIndexerDeps): TranscriptIndexerHandle {
  const watchedWorkspaces = new Map<string, () => void>(); // workspaceId -> stop
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // `${workspaceId} ${sessionId}` -> timer
  let stopped = false;

  async function processFile(workspace: RegisteredWorkspace, sessionId: string): Promise<void> {
    if (await deps.isManaged(sessionId)) return;

    const projectDir = getProjectPath(workspace.path, deps.env);
    const file = path.join(projectDir, `${sessionId}${JSONL_EXT}`);

    let contents: string;
    let mtimeMs: number;
    try {
      const [readContents, stats] = await Promise.all([readFile(file, "utf-8"), stat(file)]);
      contents = readContents;
      mtimeMs = stats.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        deps.logger.warn("[transcript-indexer] failed to read transcript", {
          file,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const parsed = parseTranscript(contents);
    if (!parsed) return;

    const running = await computeRunning(projectDir, sessionId, workspace.path, deps);

    await deps.upsert({
      machineId: deps.machineId,
      workspaceId: workspace.workspaceId,
      providerRef: sessionId,
      summary: {
        title: parsed.title,
        lastActivity: parsed.lastActivity || mtimeMs,
        running,
      },
    });
  }

  function scheduleProcess(workspace: RegisteredWorkspace, sessionId: string): void {
    if (stopped) return;
    const key = `${workspace.workspaceId} ${sessionId}`;
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        processFile(workspace, sessionId).catch((error: unknown) => {
          deps.logger.error("[transcript-indexer] processing transcript failed", {
            workspaceId: workspace.workspaceId,
            sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, deps.debounceMs),
    );
  }

  async function scanExisting(workspace: RegisteredWorkspace, projectDir: string): Promise<void> {
    try {
      const names = await readdir(projectDir);
      for (const name of names) {
        if (name.endsWith(JSONL_EXT)) {
          scheduleProcess(workspace, name.slice(0, -JSONL_EXT.length));
        }
      }
    } catch {
      // Project dir doesn't exist yet — `watchDirectoryForever`'s `onReady`
      // re-runs this before every (re)attach attempt, so it's retried too.
    }
  }

  async function watchWorkspace(workspace: RegisteredWorkspace): Promise<void> {
    if (watchedWorkspaces.has(workspace.workspaceId)) return;
    const projectDir = getProjectPath(workspace.path, deps.env);

    await scanExisting(workspace, projectDir);

    const stop = watchDirectoryForever(
      projectDir,
      (filename) => {
        if (filename?.endsWith(JSONL_EXT)) {
          scheduleProcess(workspace, filename.slice(0, -JSONL_EXT.length));
        }
      },
      deps.logger,
      () => void scanExisting(workspace, projectDir),
    );
    watchedWorkspaces.set(workspace.workspaceId, stop);
  }

  async function rescan(): Promise<void> {
    if (stopped) return;
    let workspaces: RegisteredWorkspace[];
    try {
      workspaces = await deps.listWorkspaces();
    } catch (error) {
      deps.logger.warn("[transcript-indexer] listWorkspaces failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const workspace of workspaces) {
      await watchWorkspace(workspace);
    }
  }

  void rescan();
  const rescanTimer = setInterval(() => void rescan(), deps.rescanWorkspacesMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(rescanTimer);
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      for (const stopWatcher of watchedWorkspaces.values()) stopWatcher();
      watchedWorkspaces.clear();
    },
  };
}
