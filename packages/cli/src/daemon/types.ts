/**
 * Daemon-local types (not part of the `@kvy/wire` protocol — these never
 * cross a network boundary, they're the shape of the daemon's own in-memory
 * bookkeeping). Adapted from happy-cli/src/daemon/types.ts (MIT).
 */
import type { PermissionMode, ProviderId } from "@kvy/wire";

/**
 * Encryption material a spawned session reports back to the daemon via the
 * `/session-started` webhook (kvy-system-design.md §7, §10.1). Durability
 * (§7.4, a separate task) persists exactly this shape to `sessions.json` so
 * resume survives a daemon restart without re-deriving keys.
 */
export interface SessionEncryptionData {
  /** Base64-encoded wrapped data-encryption-key for this session. */
  encryptionKey: string;
  seq: number;
  metadataVersion: number;
  agentStateVersion: number;
}

/**
 * A session process the daemon is currently tracking, one per spawned or
 * self-reported child. Fields beyond `pid`/`startedBy` are filled in only
 * once the session calls `/session-started` — a terminal-started session
 * the daemon hasn't heard from yet has just the two.
 */
export interface TrackedSession {
  /** `"daemon"` for RPC-spawned sessions, else a free-form description (e.g. `"terminal"`). */
  startedBy: "daemon" | string;
  sessionId?: string;
  provider?: ProviderId;
  permissionMode?: PermissionMode;
  metadata?: unknown;
  encryption?: SessionEncryptionData;
  pid: number;
  error?: string;
  /**
   * The resolved real (symlink-followed) directory this pid was spawned
   * into (plan.md §16 "Flow 3 — spawn-directory-dedup"). Populated by
   * `sessionRegistry.ts`'s `trackSpawned` for a daemon-spawned session — fed
   * from `spawnEngine.ts`'s own `spawnDirectory` right after launch — and
   * carried through by `onSessionStarted`'s merge for that same pid. Absent
   * for a terminal-started session the daemon only learned about via its
   * `/session-started` self-report (no `trackSpawned` call preceded it, so
   * there was nothing to record a directory against). This is exactly what
   * lets `spawnSession` answer "is a session already live in this
   * directory?" without a new registry lookup shape.
   */
  directory?: string;
}

/**
 * Options accepted by the injected `spawnSession` callback. The control
 * server only validates and forwards these — actual process spawning
 * (tmux, detached fallback, directory-creation approval) is §7.3, a
 * separate plan bullet implemented elsewhere.
 */
export interface SpawnSessionOptions {
  directory: string;
  sessionId?: string;
  provider?: ProviderId;
  permissionMode?: string;
  model?: string;
  environmentVariables?: Record<string, string>;
}

export type SpawnSessionResult =
  | { type: "success"; sessionId: string }
  | { type: "requestToApproveDirectoryCreation"; directory: string }
  | { type: "error"; errorMessage: string };

/**
 * A launched process's terminal exit info (A3/A4, docs/known-issues.md —
 * "generic 15s timeout masks the real failure reason"). `code`/`signal`
 * mirror Node's own `child_process` `"exit"` event shape; a pid-poll-based
 * watcher (no direct child handle — e.g. the tmux pane process,
 * `processLauncher.ts`) can only ever observe "gone", so both fields are
 * `null` in that case.
 */
export interface ProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Subscribes `onExit` to a launched process's eventual exit; returns an
 * unsubscribe function. If the process has already exited by the time this
 * is called, `onExit` still fires (asynchronously, so callers can always
 * treat "subscribe" as safe regardless of timing) — a subscriber never
 * silently misses an exit that raced its own subscription.
 */
export type ProcessExitWatcher = (onExit: (info: ProcessExitInfo) => void) => () => void;
