/**
 * `resumeSession` RPC's core (design §4.4: `'resumeSession'({sessionId}) →
 * { ok }               // re-spawn w/ reconnect env`; plan.md §16 "3.2
 * Durability": "`resumeSession` RPC: re-spawn with `FALCON_RECONNECT_*` env
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
 *  - The child is handed `FALCON_RECONNECT_*` env instead of nothing —
 *    the wrapped DEK + seq + version counters the session process needs to
 *    keep writing into its *existing* server-side session row rather than
 *    minting a new one.
 *
 * A still-live process for the same session is stopped first: two
 * processes must never share ownership of one session's persisted DEK/seq
 * counters (a resumed session's provider process would otherwise race the
 * old one's writes).
 */
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";
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

const PROVIDER_CLI_NAME: Record<"claude-code" | "codex", string> = {
  "claude-code": "claude",
  codex: "codex",
};

export interface ResumeSessionRegistry {
  findResumable(sessionId: string): PersistedSession | null;
  stopSession(sessionId: string): boolean;
  trackSpawned(pid: number): void;
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
  resolveDirectory: (session: PersistedSession) => string | null | undefined | Promise<string | null | undefined>;
  /** Extra env vars merged in ahead of the `FALCON_RECONNECT_*` set (rare; mirrors `spawnEngine.ts`'s shape). */
  baseEnv?: NodeJS.ProcessEnv;
  launchProcess?: typeof launchProviderProcessDefault;
  launchDeps?: LaunchProcessDeps;
  /** Returns the argv that re-invokes this same falcon binary. Injectable for tests. */
  falconEntrypoint?: () => string[];
  logger?: Logger;
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

function defaultFalconEntrypoint(): string[] {
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  return [process.execPath, ...process.execArgv, entry];
}

/** The `FALCON_RECONNECT_*` env contract a resumed session process reads to re-attach to its existing server-side session row instead of bootstrapping a new one. */
function buildReconnectEnv(sessionId: string, session: PersistedSession): NodeJS.ProcessEnv {
  return {
    FALCON_RECONNECT_SESSION_ID: sessionId,
    FALCON_RECONNECT_ENCRYPTION_KEY: session.encryption.encryptionKey,
    FALCON_RECONNECT_SEQ: String(session.encryption.seq),
    FALCON_RECONNECT_METADATA_VERSION: String(session.encryption.metadataVersion),
    FALCON_RECONNECT_AGENT_STATE_VERSION: String(session.encryption.agentStateVersion),
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
  // processes must never share ownership of one session's DEK/seq.
  deps.registry.stopSession(sessionId);

  const [command, ...prefixArgs] = deps.falconEntrypoint?.() ?? defaultFalconEntrypoint();
  if (!command) {
    throw new ResumeSessionError("could not resolve the falcon entrypoint to re-invoke");
  }

  const providerCliName = PROVIDER_CLI_NAME[persisted.provider ?? "claude-code"];
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

  deps.registry.trackSpawned(launched.pid);
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
