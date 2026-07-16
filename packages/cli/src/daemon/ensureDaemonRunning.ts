import { createDaemonCommandDeps, type DaemonCommandDeps, runDaemonStart } from "./commands.js";
import { type DaemonState, readDaemonState } from "./state.js";

/**
 * `ensureDaemonRunning()` — auto-start wiring for every agent-invoking
 * `falcon` subcommand (plan.md §16 1.5, design §7.2/§8; PRD FR-1.2: "First
 * run of `falcon` triggers ... daemon auto-start — no separate setup
 * steps").
 *
 * Checks `daemon.state.json` (`state.ts`) for an existing daemon, then
 * verifies it's actually alive via the exact `kill(pid, 0)` liveness probe
 * `lock.ts` uses for its own stale-lock detection (`isProcessAlive`,
 * threaded through here via `DaemonCommandDeps` the same way `commands.ts`
 * already does) — a state file naming a dead pid (daemon crashed without
 * cleanup) is treated identically to no state file at all. If no live
 * daemon is found, this delegates straight to the already-merged
 * `runDaemonStart` (`commands.ts`): it spawns `daemon start-sync` detached
 * and polls `daemon.state.json` until it reports ready or `readyTimeoutMs`
 * elapses. No spawn/poll logic is duplicated here — this is a thin
 * "is one already up, else start one and confirm" wrapper.
 *
 * Respects `FALCON_NO_SERVICE=1` (the env convention already documented in
 * `index.ts`'s help text): when set, returns `{ ok: false, reason:
 * "disabled" }` without reading any state or spawning anything — the user
 * has explicitly opted out of daemon auto-management, so callers should
 * treat "disabled" the same as success and simply proceed without a
 * running daemon.
 */
export interface EnsureDaemonRunningDeps extends DaemonCommandDeps {
  env: NodeJS.ProcessEnv;
}

export function createEnsureDaemonRunningDeps(
  overrides: Partial<EnsureDaemonRunningDeps> = {},
): EnsureDaemonRunningDeps {
  const { env, ...daemonOverrides } = overrides;
  return {
    ...createDaemonCommandDeps(daemonOverrides),
    env: env ?? process.env,
  };
}

export type EnsureDaemonRunningResult =
  | { ok: true; state: DaemonState }
  | { ok: false; reason: "disabled" }
  | { ok: false; reason: "start-failed"; message: string };

export async function ensureDaemonRunning(
  deps: EnsureDaemonRunningDeps,
): Promise<EnsureDaemonRunningResult> {
  if (deps.env.FALCON_NO_SERVICE === "1") {
    return { ok: false, reason: "disabled" };
  }

  const existing = await readDaemonState(deps.homeDir);
  if (existing && deps.isProcessAlive(existing.pid)) {
    return { ok: true, state: existing };
  }

  const started = await runDaemonStart(deps, { noWait: false });
  if (started.code !== 0) {
    return { ok: false, reason: "start-failed", message: started.message };
  }

  // runDaemonStart only returns code 0 once it has itself re-read
  // daemon.state.json and confirmed the pid is alive, so this should
  // always succeed — re-reading here (rather than trusting a cached value)
  // keeps this function honest about what it's actually reporting back.
  const state = await readDaemonState(deps.homeDir);
  if (!state) {
    return {
      ok: false,
      reason: "start-failed",
      message: "falcon: daemon reported ready but daemon.state.json is missing\n",
    };
  }
  return { ok: true, state };
}
