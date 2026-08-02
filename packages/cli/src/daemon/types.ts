import type { PermissionMode, ProviderId } from "@kvy/wire";

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
   * The resolved real (symlink-followed) directory this pid was spawned into.
   * Absent for terminal-started sessions (no `trackSpawned` call preceded them).
   */
  directory?: string;
}

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
 * `code`/`signal` mirror Node's `child_process` `"exit"` event; a pid-poll-based
 * watcher (no direct child handle) can only ever observe "gone", so both are `null`.
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
