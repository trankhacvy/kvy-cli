/**
 * CLI-side client for the `/session-started` self-report webhook.
 *
 * Best-effort: a session must work standalone with no daemon present, so
 * nothing here ever throws — every outcome is a typed result the caller
 * can log and move past.
 *
 * `pid` defaults to `process.pid`. A terminal-started session has no pending
 * spawn awaiter for its pid, so `resolve()` on the daemon side is a no-op.
 */

import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import { isProcessAlive } from "./lock.js";
import { readDaemonState } from "./state.js";
import type { SessionEncryptionData } from "./types.js";

export interface NotifyDaemonSessionStartedParams {
  sessionId: string;
  metadata?: unknown;
  encryption?: SessionEncryptionData;
  /** Defaults to `process.pid`. */
  pid?: number;
}

export interface NotifyDaemonSessionStartedDeps {
  homeDir: string;
  /** Injectable so unit tests never make a real network call. */
  fetchImpl: typeof fetch;
  isProcessAlive: (pid: number) => boolean;
  logger?: Logger;
  /** Request timeout in ms — a wedged daemon must not hang session startup. */
  timeoutMs?: number;
}

export type NotifyDaemonSessionStartedResult =
  | { type: "no-daemon" }
  | { type: "ok" }
  | { type: "unreachable"; error: string };

const DEFAULT_TIMEOUT_MS = 2000;

export function createNotifyDaemonSessionStartedDeps(
  overrides: Partial<NotifyDaemonSessionStartedDeps> = {},
): NotifyDaemonSessionStartedDeps {
  return {
    homeDir: resolveHomeDir(),
    fetchImpl: fetch,
    isProcessAlive,
    ...overrides,
  };
}

/**
 * Best-effort self-report to the daemon's control server. Never throws:
 * every failure mode (no daemon running, stale state, unreachable control
 * server, non-2xx response, network error) collapses to a typed result
 * standalone with no daemon present at all.
 */
export async function notifyDaemonSessionStarted(
  deps: NotifyDaemonSessionStartedDeps,
  params: NotifyDaemonSessionStartedParams,
): Promise<NotifyDaemonSessionStartedResult> {
  const {
    homeDir,
    fetchImpl,
    isProcessAlive: checkAlive,
    logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  const state = await readDaemonState(homeDir);
  if (!state || !checkAlive(state.pid)) {
    logger?.debug("[notify] no daemon running, skipping session self-report", {
      sessionId: params.sessionId,
    });
    return { type: "no-daemon" };
  }

  try {
    const body: NotifyDaemonSessionStartedParams = { pid: process.pid, ...params };
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/session-started`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const error = `daemon responded with HTTP ${res.status}`;
      logger?.warn("[notify] daemon rejected session self-report", {
        sessionId: params.sessionId,
        error,
      });
      return { type: "unreachable", error };
    }

    logger?.debug("[notify] session self-report delivered to daemon", {
      sessionId: params.sessionId,
    });
    return { type: "ok" };
  } catch (error) {
    // Transient failures (daemon crashed mid-request, timeout, connection
    // refused after a stale-but-alive-looking pid) must never block session
    // startup — log and swallow.
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn("[notify] failed to reach daemon control server", {
      sessionId: params.sessionId,
      error: message,
    });
    return { type: "unreachable", error: message };
  }
}

/**
 * A4 (docs/known-issues.md — "generic 15s timeout masks the real failure
 * reason"): the CLI-side client half of the `/session-start-failed`
 * self-report webhook (`controlServer.ts`). Called from `start.ts`'s/
 * `startCodex.ts`'s `bootstrapSession()` catch block — the one place a
 * daemon-spawned session can fail before it ever has a `sessionId` to
 * report anything else with. Same best-effort contract as
 * `notifyDaemonSessionStarted` above: never throws, and an absent/
 * unreachable daemon is a normal, silent no-op — a session must still fail
 * (and print its own honest error to stderr) exactly the same whether or
 * not a daemon is listening.
 *
 * `pid` defaults to `process.pid`, same correlation key
 * `notifyDaemonSessionStarted` uses — `spawnAwaiter.ts`'s `reject(pid,
 * error)` matches it back to the pending `spawn` RPC.
 */
export interface ReportSessionStartFailedParams {
  error: string;
  /** Defaults to `process.pid`. */
  pid?: number;
}

export type ReportSessionStartFailedResult =
  | { type: "no-daemon" }
  | { type: "ok" }
  | { type: "unreachable"; error: string };

export async function reportSessionStartFailed(
  deps: NotifyDaemonSessionStartedDeps,
  params: ReportSessionStartFailedParams,
): Promise<ReportSessionStartFailedResult> {
  const {
    homeDir,
    fetchImpl,
    isProcessAlive: checkAlive,
    logger,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  const state = await readDaemonState(homeDir);
  if (!state || !checkAlive(state.pid)) {
    logger?.debug("[notify] no daemon running, skipping session-start-failed self-report");
    return { type: "no-daemon" };
  }

  try {
    const pid = params.pid ?? process.pid;
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/session-start-failed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid, error: params.error }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const error = `daemon responded with HTTP ${res.status}`;
      logger?.warn("[notify] daemon rejected session-start-failed self-report", { error });
      return { type: "unreachable", error };
    }

    logger?.debug("[notify] session-start-failed self-report delivered to daemon");
    return { type: "ok" };
  } catch (error) {
    // Same "never block the caller's own failure path" contract as
    // `notifyDaemonSessionStarted` — this is a best-effort ADDITION to an
    // already-failing start, never allowed to introduce a new crash.
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn("[notify] failed to reach daemon control server (session-start-failed)", {
      error: message,
    });
    return { type: "unreachable", error: message };
  }
}
