/**
 * `resumeSession` RPC's core (design §4.4: `'resumeSession'({sessionId}) →
 * { ok }               // re-spawn w/ reconnect env`; plan.md §16 "3.2
 * Durability": "`resumeSession` RPC: re-spawn with `KVY_RECONNECT_*` env
 * re-attaching to the same server session row").
 *
 * Ported, with changes, from Happy's `resumeSession` closure in
 * `daemon/run.ts` (https://github.com/slopus/happy, MIT). Reuses the exact
 * same building blocks as the already-landed `spawn` RPC
 * (`spawnEngine.ts`): `processLauncher.ts`'s tmux-preferred launch and
 * `spawnAwaiter.ts`'s pid↔webhook matching. The two real differences from a
 * fresh spawn:
 *
 *  - The session to relaunch is looked up in the daemon's own registry
 *    (`sessionRegistry.ts`), not validated against a remote-supplied
 *    workspace path — design §12's "no arbitrary-directory execution from
 *    remote" concern is about a *caller-supplied* directory; here the
 *    directory comes from what this daemon already recorded for this
 *    session, so `workspacePath.ts`'s validation doesn't apply.
 *  - The child is handed `KVY_RECONNECT_*` env instead of nothing —
 *    the wrapped DEK + seq + version counters the session process needs to
 *    keep writing into its *existing* server-side session row rather than
 *    minting a new one.
 *
 * A still-live process for the same session is stopped first: two
 * processes must never share ownership of one session's persisted DEK/seq
 * counters (a resumed session's provider process would otherwise race the
 * old one's writes). "Stopped" means *confirmed dead*, not just signalled —
 * `stopSession` only sends SIGTERM, so this module polls `isAlive` on the
 * old pid (reusing `kill.ts`'s SIGTERM-then-wait-then-SIGKILL escalation
 * pattern) before proceeding to launch the replacement process, closing the
 * window where both could otherwise be alive at once.
 */
import { realpath } from "node:fs/promises";
import { defaultKvyEntrypoint } from "../kvyEntrypoint.js";
import type { Logger } from "../logger.js";
import { PROVIDER_REGISTRY } from "../provider/registry.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
} from "./processLauncher.js";
import type { PersistedSession } from "./sessionsStore.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";

/** Thrown for any failure along the resume path — unknown session, no resolvable directory, launch failure, or the post-launch webhook wait. */
export class ResumeSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeSessionError";
  }
}

export interface ResumeSessionRegistry {
  findResumable(sessionId: string): PersistedSession | null;
  stopSession(sessionId: string): boolean;
  /** The pid currently tracked live for `sessionId`, or `null` if none — used to poll for exit after `stopSession`. */
  getLivePid(sessionId: string): number | null;
  /**
   * Re-tracks the relaunched pid. `directory` is the resolved real path the
   * session is being resumed into (plan.md §16 "Flow 3 —
   * spawn-directory-dedup"): passing it through keeps the restored session
   * matchable by `spawnEngine.ts`'s `scanForLiveSessionInDirectory` after a
   * daemon restart, instead of coming back with `directory: undefined`.
   */
  trackSpawned(pid: number, directory?: string): void;
}

export interface ResumeSessionDeps {
  registry: ResumeSessionRegistry;
  /** Matches the relaunched process's pid to its `/session-started` webhook — same awaiter instance `spawnEngine.ts` uses. */
  awaiter: SpawnAwaiter;
  /**
   * Resolves the working directory to relaunch `sessionId` in from its
   * persisted record. Persisted sessions carry only an opaque `metadata`
   * blob (whatever the session originally self-reported) — this is the
   * seam a workspace/metadata schema plugs into once it exists; returning
   * `null`/`undefined` fails the resume rather than guessing a directory.
   */
  resolveDirectory: (
    session: PersistedSession,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** Extra env vars merged in ahead of the `KVY_RECONNECT_*` set (rare; mirrors `spawnEngine.ts`'s shape). */
  baseEnv?: NodeJS.ProcessEnv;
  launchProcess?: typeof launchProviderProcessDefault;
  launchDeps?: LaunchProcessDeps;
  /** Returns the argv that re-invokes this same kvy binary. Injectable for tests. */
  kvyEntrypoint?: () => string[];
  logger?: Logger;
  /** Liveness probe for the old process's pid while waiting for it to exit. Injectable for tests; defaults to `kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Sends `signal` to a pid, swallowing ESRCH. Injectable for tests; defaults to `process.kill`. */
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the old process to exit (after SIGTERM) before escalating to SIGKILL. Default 5s, matching `kill.ts`'s grace period. */
  stopTimeoutMs?: number;
}

export interface ResumeSessionResult {
  sessionId: string;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_STOP_TIMEOUT_MS = 5000;
const STOP_POLL_INTERVAL_MS = 200;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: genuinely dead. Anything else (e.g. EPERM): treat as still
    // alive rather than risk launching a second owner of this session's
    // DEK/seq — see kill.ts's `defaultIsAlive` for the same reasoning.
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return true;
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms `pid` has actually exited before returning, escalating to
 * SIGKILL if it's still alive after `timeoutMs` — the same
 * SIGTERM-then-wait-then-SIGKILL pattern `kill.ts`'s `killGraceful` uses.
 * `stopSession` has already sent the SIGTERM by the time this is called;
 * this only polls (and, if needed, escalates).
 */
async function waitForOldProcessToExit(
  pid: number,
  sessionId: string,
  deps: {
    isAlive: (pid: number) => boolean;
    killPid: (pid: number, signal: NodeJS.Signals) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    logger: Logger;
  },
  timeoutMs: number,
): Promise<void> {
  const deadline = deps.now() + timeoutMs;
  while (deps.isAlive(pid) && deps.now() < deadline) {
    await deps.sleep(STOP_POLL_INTERVAL_MS);
  }

  if (!deps.isAlive(pid)) return;

  deps.logger.warn("[resume-session] old process ignored SIGTERM within timeout, sending SIGKILL", {
    sessionId,
    pid,
  });
  deps.killPid(pid, "SIGKILL");

  if (deps.isAlive(pid)) {
    throw new ResumeSessionError(
      `old process (pid ${pid}) for session ${sessionId} would not exit even after SIGKILL; refusing to launch a replacement to avoid two processes sharing the same session's DEK/seq`,
    );
  }
}

/** The `KVY_RECONNECT_*` env contract a resumed session process reads to re-attach to its existing server-side session row instead of bootstrapping a new one. */
function buildReconnectEnv(sessionId: string, session: PersistedSession): NodeJS.ProcessEnv {
  return {
    KVY_RECONNECT_SESSION_ID: sessionId,
    KVY_RECONNECT_ENCRYPTION_KEY: session.encryption.encryptionKey,
    KVY_RECONNECT_SEQ: String(session.encryption.seq),
    KVY_RECONNECT_METADATA_VERSION: String(session.encryption.metadataVersion),
    KVY_RECONNECT_AGENT_STATE_VERSION: String(session.encryption.agentStateVersion),
  };
}

export async function resumeSession(
  sessionId: string,
  deps: ResumeSessionDeps,
): Promise<ResumeSessionResult> {
  const logger = deps.logger ?? noopLogger;
  const baseEnv = deps.baseEnv ?? process.env;

  const persisted = deps.registry.findResumable(sessionId);
  if (!persisted) {
    throw new ResumeSessionError(
      `session ${sessionId} is not tracked by this daemon and has no persisted resume data`,
    );
  }

  const directory = await deps.resolveDirectory(persisted);
  if (!directory) {
    throw new ResumeSessionError(
      `could not resolve a working directory to resume session ${sessionId} in`,
    );
  }

  // Stop any still-live process for this session BEFORE relaunching — two
  // processes must never share ownership of one session's DEK/seq. Capture
  // the pid before stopping: `stopSession` only sends SIGTERM and doesn't
  // remove the pid from the live map, so it stays resolvable, but we still
  // want the identity fixed ahead of the call for clarity.
  const livePid = deps.registry.getLivePid(sessionId);
  const wasLive = deps.registry.stopSession(sessionId);
  if (wasLive && livePid != null) {
    await waitForOldProcessToExit(
      livePid,
      sessionId,
      {
        isAlive: deps.isAlive ?? defaultIsAlive,
        killPid: deps.killPid ?? defaultKillPid,
        sleep: deps.sleep ?? defaultSleep,
        now: deps.now ?? Date.now,
        logger,
      },
      deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    );
  }

  const [command, ...prefixArgs] = deps.kvyEntrypoint?.() ?? defaultKvyEntrypoint();
  if (!command) {
    throw new ResumeSessionError("could not resolve the kvy entrypoint to re-invoke");
  }

  // Headless-vs-terminal decision (plan-v2.md W3.7): this module ALWAYS
  // relaunches with `--starting-mode remote`, deliberately, regardless of
  // whatever mode the original session ran in. The daemon has no controlling
  // TTY to hand a re-spawned process — there is no terminal here to run a
  // PTY-injection session on — so "headless" is the only honest choice for
  // *this* relaunch path. A resumed *terminal* session (a human re-running
  // `kvy claude` themselves) is a different call path entirely and is not
  // routed through here: it goes straight through `commands/start.ts`'s PTY
  // flow, which re-attaches via the `KVY_RECONNECT_SESSION_ID`/
  // `KVY_RECONNECT_ENCRYPTION_KEY` env this function already sets below
  // (honored by `session/bootstrap.ts`) plus, when available,
  // `KVY_RECONNECT_PROVIDER_SESSION_ID` to resume the provider transcript
  // itself — this module has no provider session id to offer (persisted
  // sessions only carry the opaque `metadata` blob), so it doesn't set that
  // one.
  const providerCliName = PROVIDER_REGISTRY[persisted.provider ?? "claude-code"].kvySubcommand;
  const args = [
    ...prefixArgs,
    providerCliName,
    "--starting-mode",
    "remote",
    "--started-by",
    "daemon",
  ];

  const launch = deps.launchProcess ?? launchProviderProcessDefault;
  let launched: Awaited<ReturnType<typeof launchProviderProcessDefault>>;
  try {
    launched = await launch(
      {
        sessionLabel: sessionId,
        command,
        args,
        cwd: directory,
        env: { ...baseEnv, ...buildReconnectEnv(sessionId, persisted) },
      },
      deps.launchDeps,
    );
  } catch (error) {
    throw new ResumeSessionError(
      `failed to launch provider process for resume: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Re-record the directory this session was resumed into, so a
  // subsequent spawn into the same directory still dedups against it — the
  // whole point of persisting `PersistedSession.directory` across a daemon
  // restart (plan.md §16 "Flow 3 — spawn-directory-dedup").
  deps.registry.trackSpawned(launched.pid, directory);
  logger.info("[resume-session] launched provider process", {
    method: launched.method,
    pid: launched.pid,
    sessionId,
  });

  try {
    const started = await deps.awaiter.waitFor(launched.pid);
    return { sessionId: started.sessionId };
  } catch (error) {
    throw new ResumeSessionError(
      `resume launched (pid ${launched.pid}, ${launched.method}) but ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The real default `resolveDirectory` for a `resumeSession` relaunch, now that
 * `PersistedSession` carries the session's spawn `directory` across a daemon
 * restart (plan.md §16 "Flow 3 — spawn-directory-dedup"). Re-resolves the
 * stored path via `realpath` rather than trusting the stored string verbatim:
 * spawn-dedup matches directories by exact string equality against a
 * *freshly* `realpath`-resolved spawn target (`spawnEngine.ts`'s
 * `scanForLiveSessionInDirectory`), so the resumed session must be re-tracked
 * under that same canonical form to line up. Returns `undefined` — failing the
 * resume cleanly rather than guessing — when the record carries no directory,
 * or when `realpath` throws (directory deleted/unmounted since it was
 * persisted).
 */
export async function resolveResumeDirectoryFromRecord(
  session: PersistedSession,
): Promise<string | undefined> {
  if (!session.directory) return undefined;
  try {
    return await realpath(session.directory);
  } catch {
    return undefined;
  }
}
