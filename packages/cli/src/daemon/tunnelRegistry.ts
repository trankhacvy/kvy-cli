/**
 * Tunnel registry for `preview.open`/`preview.close`/`preview.tunnels`: the
 * daemon-managed `cloudflared` quick-tunnel child registry.
 *
 * Two halves, deliberately split (mirrors `sessionRegistry.ts` +
 * `sessionsStore.ts`'s own live-map/durable-store split):
 *
 *  - **In-memory registry** (`createTunnelRegistry`) — `tunnelId ->
 *    TrackedTunnel`, the live source of truth `previewTunnel.ts` reads/
 *    writes. Deliberately NOT persisted across a daemon restart: a
 *    `trycloudflare.com` URL is only valid for as long as its `cloudflared`
 *    process stays connected, so resurrecting a stale one from disk after a
 *    restart would just hand back a dead link. A restart cleanly drops every
 *    tracked tunnel; `reapOrphanedTunnels` below is what stops the
 *    now-orphaned child processes themselves from leaking.
 *  - **Durable pid journal** (`~/.kvy/tunnels.json`) — a flat
 *    `{pid, port, startedAt}[]`, no URLs. This exists purely so a daemon
 *    that crashes/SIGKILLs doesn't leak `cloudflared` children forever:
 *    `kill.ts`/`markers.ts`'s argv-marker process discovery can never find a
 *    `cloudflared` child (it carries no Kvy marker), so without this
 *    journal there is no way for `reapOrphanedTunnels` (called at daemon
 *    boot) to even know a tunnel process might still be alive. Same
 *    tmp-write + rename atomicity convention as `sessionsStore.ts`/
 *    `state.ts`, with its own write-queue serialization (kept as a separate
 *    file/lock on purpose, mirroring `workspace/registry.ts`'s own
 *    "disjoint from sibling settings.json writers" precedent) — this task
 *    has nothing to do with `sessions.json`'s writers.
 */
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import { createKillDeps, type KillSignal } from "./kill.js";
import type { ProcessEntry } from "./processScan.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

export interface TrackedTunnel {
  tunnelId: string;
  port: number;
  url: string;
  pid: number;
  startedAt: number;
  status: "starting" | "active";
  child: ChildProcess;
}

export interface TunnelRegistry {
  add(tunnel: TrackedTunnel): void;
  get(tunnelId: string): TrackedTunnel | undefined;
  getByPort(port: number): TrackedTunnel | undefined;
  list(): TrackedTunnel[];
  remove(tunnelId: string): void;
  /** Updates an already-tracked tunnel's status in place (`'starting' -> 'active'` once the URL is parsed). No-op if `tunnelId` isn't tracked. */
  setStatus(tunnelId: string, status: TrackedTunnel["status"]): void;
}

/** A fresh, empty in-memory tunnel registry — one instance per daemon process, constructed once at machine-integration boot (mirrors `sessionRegistry.ts`'s own single-instance-per-daemon convention). */
export function createTunnelRegistry(): TunnelRegistry {
  const tunnels = new Map<string, TrackedTunnel>();

  return {
    add(tunnel) {
      tunnels.set(tunnel.tunnelId, tunnel);
    },
    get(tunnelId) {
      return tunnels.get(tunnelId);
    },
    getByPort(port) {
      for (const tunnel of tunnels.values()) {
        if (tunnel.port === port) return tunnel;
      }
      return undefined;
    },
    list() {
      return [...tunnels.values()];
    },
    remove(tunnelId) {
      tunnels.delete(tunnelId);
    },
    setStatus(tunnelId, status) {
      const tunnel = tunnels.get(tunnelId);
      if (tunnel) tunnel.status = status;
    },
  };
}

// ---------------------------------------------------------------------------
// Durable pid journal (~/.kvy/tunnels.json)
// ---------------------------------------------------------------------------

export interface TunnelJournalEntry {
  pid: number;
  port: number;
  startedAt: number;
}

/** Bumped whenever this shape changes — same honest-on-disk-marker contract as `sessionsStore.ts`'s `SESSIONS_SCHEMA_VERSION`; no migration branch exists or is needed yet. */
export const TUNNELS_JOURNAL_SCHEMA_VERSION = 1;

interface TunnelsJournalFileShape {
  schemaVersion: number;
  entries: TunnelJournalEntry[];
}

export function tunnelsJournalPath(homeDir: string): string {
  return path.join(homeDir, "tunnels.json");
}

function isTunnelJournalEntry(value: unknown): value is TunnelJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.pid === "number" && typeof c.port === "number" && typeof c.startedAt === "number";
}

/** Reads every well-formed journal entry. A missing/corrupt file — or one with a malformed entry — resolves to `[]` (bad entries silently dropped) rather than throwing: this journal is a best-effort orphan-reaping aid, never load-bearing enough to crash daemon boot over. */
export async function readTunnelJournal(homeDir: string): Promise<TunnelJournalEntry[]> {
  try {
    const raw = await readFile(tunnelsJournalPath(homeDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const entries = (parsed as Partial<TunnelsJournalFileShape>).entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter(isTunnelJournalEntry);
  } catch {
    return [];
  }
}

// One write-chain per homeDir — same pattern (and same reasoning) as
// `sessionsStore.ts`'s own `serialize`, kept as an independent map here since
// this is a different file with different writers.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(homeDir) ?? Promise.resolve();
  const settleResult = previous.then(fn, fn);
  writeChains.set(
    homeDir,
    settleResult.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settleResult;
}

async function writeJournalFile(homeDir: string, entries: TunnelJournalEntry[]): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const file = tunnelsJournalPath(homeDir);
  const tmpFile = `${file}.tmp`;
  const payload: TunnelsJournalFileShape = {
    schemaVersion: TUNNELS_JOURNAL_SCHEMA_VERSION,
    entries,
  };
  await writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpFile, file); // atomic on POSIX
}

/** Records a freshly-spawned `cloudflared` pid, immediately after spawn — before its URL has even been parsed — so a crash in that window still leaves a journal entry `reapOrphanedTunnels` can find. */
export async function appendJournalEntry(
  homeDir: string,
  entry: TunnelJournalEntry,
): Promise<void> {
  await serialize(homeDir, async () => {
    const existing = await readTunnelJournal(homeDir);
    existing.push(entry);
    await writeJournalFile(homeDir, existing);
  });
}

/** Removes one journaled pid (clean close, or the child exiting on its own). A no-op if the pid isn't present. */
export async function removeJournalEntry(homeDir: string, pid: number): Promise<void> {
  await serialize(homeDir, async () => {
    const existing = await readTunnelJournal(homeDir);
    const filtered = existing.filter((entry) => entry.pid !== pid);
    if (filtered.length === existing.length) return;
    await writeJournalFile(homeDir, filtered);
  });
}

/** Deletes `tunnels.json` outright (or writes an empty entry list — either is fine since the read path treats both as "no entries"). Used at the end of `reapOrphanedTunnels`; a no-op if the file is already absent. */
export async function clearTunnelJournal(homeDir: string): Promise<void> {
  await serialize(homeDir, async () => {
    await unlink(tunnelsJournalPath(homeDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}

// ---------------------------------------------------------------------------
// Boot-time orphan reaping
// ---------------------------------------------------------------------------

export interface ReapOrphanedTunnelsDeps {
  listProcesses: () => Promise<ProcessEntry[]>;
  killPid: (pid: number, signal: KillSignal) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  gracefulTimeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

/** Fills in real OS-backed defaults (reusing `kill.ts`'s primitives, same convention as `adoptTake.ts`'s `createAdoptTakeDeps`) for anything not overridden. */
export function createReapOrphanedTunnelsDeps(
  overrides: Partial<ReapOrphanedTunnelsDeps> = {},
): ReapOrphanedTunnelsDeps {
  const killDeps = createKillDeps();
  return {
    listProcesses: killDeps.listProcesses,
    killPid: killDeps.killPid,
    isAlive: killDeps.isAlive,
    sleep: killDeps.sleep,
    now: killDeps.now,
    gracefulTimeoutMs: DEFAULT_GRACEFUL_TIMEOUT_MS,
    ...overrides,
  };
}

async function waitForExit(
  pid: number,
  deps: Pick<ReapOrphanedTunnelsDeps, "isAlive" | "sleep" | "now">,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.isAlive(pid) && deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
  }
  return deps.isAlive(pid);
}

/**
 * Called once at daemon boot (`machineIntegration.ts`), before any
 * `preview.open` RPC can run: reads the pid journal and, for every entry
 * whose pid is (a) still alive AND (b) currently running a command that
 * contains `cloudflared` — verified fresh against `listProcesses()`, never
 * trusted blindly, since pids get recycled by the OS — SIGTERM-then-wait
 * (`gracefulTimeoutMs`, default 5s)-then-SIGKILL it, exactly like
 * `kill.ts`'s escalation policy. A pid that's alive but running something
 * else entirely (recycled) is left alone and just quietly dropped from the
 * journal. Always truncates the journal at the end, regardless of how many
 * entries needed killing — a journal entry only ever describes a
 * best-effort "this pid might still be a tunnel", never a guarantee.
 */
export async function reapOrphanedTunnels(
  homeDir: string,
  deps: ReapOrphanedTunnelsDeps = createReapOrphanedTunnelsDeps(),
): Promise<void> {
  const logger = deps.logger ?? noopLogger;
  const gracefulTimeoutMs = deps.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
  const entries = await readTunnelJournal(homeDir);
  if (entries.length === 0) return;

  const processes = await deps.listProcesses();
  const byPid = new Map(processes.map((p) => [p.pid, p]));

  for (const entry of entries) {
    if (!deps.isAlive(entry.pid)) continue;
    const process = byPid.get(entry.pid);
    if (!process?.command.includes("cloudflared")) {
      logger.warn(
        "[tunnel-registry] journaled pid is alive but no longer running cloudflared (likely recycled) — leaving it alone",
        { pid: entry.pid, port: entry.port },
      );
      continue;
    }

    deps.killPid(entry.pid, "SIGTERM");
    logger.info("[tunnel-registry] reaping orphaned cloudflared tunnel: SIGTERM sent", {
      pid: entry.pid,
      port: entry.port,
    });
    const stillAlive = await waitForExit(entry.pid, deps, gracefulTimeoutMs);
    if (stillAlive) {
      deps.killPid(entry.pid, "SIGKILL");
      logger.warn("[tunnel-registry] orphaned cloudflared tunnel ignored SIGTERM, sent SIGKILL", {
        pid: entry.pid,
        port: entry.port,
      });
    }
  }

  await clearTunnelJournal(homeDir);
}
