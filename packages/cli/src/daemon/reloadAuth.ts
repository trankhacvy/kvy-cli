/**
 * CLI-side client for the daemon's `/reload-auth` control endpoint.
 *
 * After an inline re-pair, the daemon is still holding the old revoked device
 * session. This asks it to re-read `access.key` and restart machine integration
 * in place, rather than requiring a second `kvy` invocation.
 *
 * Best-effort: never throws. No daemon, unreachable daemon, or non-2xx all collapse to `false`.
 */
import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import { isProcessAlive } from "./lock.js";
import { readDaemonState } from "./state.js";

export interface ReloadDaemonAuthDeps {
  fetchImpl: typeof fetch;
  isProcessAlive: (pid: number) => boolean;
  logger?: Logger;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createReloadDaemonAuthDeps(
  overrides: Partial<ReloadDaemonAuthDeps> = {},
): ReloadDaemonAuthDeps {
  return { fetchImpl: fetch, isProcessAlive, ...overrides };
}

export async function reloadDaemonAuth(
  homeDir: string = resolveHomeDir(),
  deps: ReloadDaemonAuthDeps = createReloadDaemonAuthDeps(),
): Promise<boolean> {
  const state = await readDaemonState(homeDir);
  if (!state || !deps.isProcessAlive(state.pid)) return false;

  try {
    const res = await deps.fetchImpl(`http://127.0.0.1:${state.port}/reload-auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      deps.logger?.warn("[reload-auth] daemon rejected the reload", { status: res.status });
      return false;
    }
    return true;
  } catch (error) {
    deps.logger?.warn("[reload-auth] failed to reach the daemon control server", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
