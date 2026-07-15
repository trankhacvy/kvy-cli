/**
 * `notifyDaemonSessionStarted` — the CLI-side client half of the
 * `/session-started` self-report webhook (design §7.1, plan.md line 697).
 *
 * A freshly-started session process discovers the running daemon's control
 * server via `daemon.state.json` (`state.ts`) and POSTs its `sessionId` +
 * encryption material to it, so the daemon can track/persist/resume the
 * session (§7.4). This is **best-effort**: a session must work fine
 * standalone with no daemon present at all, so nothing here ever throws —
 * every outcome (no daemon, daemon unreachable, success) is a typed result
 * the caller can log and move past without blocking session startup.
 *
 * The server-side contract (`SessionStartedBodySchema` in `controlServer.ts`)
 * is load-bearing and out of scope to change here — this module only shapes
 * its request to match that schema.
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
 * instead of an exception, per design §7.1 — a session must work fine
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
    const res = await fetchImpl(`http://127.0.0.1:${state.port}/session-started`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
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
