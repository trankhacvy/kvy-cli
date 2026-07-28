/**
 * The daemon `spawn` RPC's core (design §7.3/§4.4, plan.md §16 "3.1 Remote
 * spawn"): validate the target workspace path, expand any templated env
 * vars, launch the provider CLI tmux-preferred (detached fallback), and
 * block until the spawned process's `/session-started` webhook reports its
 * `sessionId` back (matched by pid — `spawnAwaiter.ts`).
 *
 * Launches `falcon <provider> --starting-mode remote --started-by daemon`
 * (design §7.3, `daemon/markers.ts`'s documented process-marker convention)
 * by re-invoking this same falcon entrypoint, the same way
 * `daemon/commands.ts`'s `defaultSpawnStartSync` re-invokes itself for
 * `daemon start-sync` — `process.execPath` + `process.execArgv` + the
 * on-disk entry path works identically whether this process is running
 * under `tsx`, as `node dist/index.mjs`, or via the `bin/falcon.mjs` shim.
 *
 * Idempotency-key replay (design: "an RPC retry must NEVER double-spawn") is
 * the caller's responsibility (`machineRpc.ts`) — this function always
 * performs a real spawn attempt when called; it never caches results itself.
 *
 * When the target directory doesn't exist yet, this resolves with a
 * `requiresApproval` result (`@falcon/wire`'s `SpawnResult`, plan.md §16
 * "3.1 Remote spawn" — "409 directory-creation approval loop") instead of
 * throwing — the web New Session flow offers to create it (`fs.mkdir`) and
 * retries `spawn` with the same `idempotencyKey`. The same now applies when
 * `workspaceId` itself is simply unregistered (plan.md §16 "Flow 3 —
 * spawn-fresh-folder-register (Piece A)": a genuinely fresh folder picked
 * cold in the web UI, never `falcon workspace register`'d from a
 * terminal) — that resolves to a `register-workspace` approval instead of a
 * dead-end error, mirroring the create-directory loop exactly (the web
 * confirms, calls the new `workspace.register` RPC, and retries `spawn`).
 * Every OTHER validation failure (outside-workspace-root escape,
 * not-absolute, not-a-directory) still throws `SpawnError`: those are real
 * rejections, not "please add this for me" — see `workspacePath.ts`'s own
 * doc comment on why `unknown-workspace` alone gets this graceful
 * treatment (design §12's "no arbitrary-directory execution from remote"
 * boundary stays intact — registration only ever happens via this explicit,
 * user-confirmed approval step, never as a silent side effect of `spawn`
 * itself).
 *
 * `params.branch` (P1, falcon-prd.md FR-1.2 "`falcon -b <branch>`") is
 * resolved via `gitWorktree.ts` after workspace validation succeeds: the
 * provider process launches in the branch's worktree directory instead of
 * the workspace root when `createWorktree` is set.
 *
 * **Directory dedup (plan.md §16 "Flow 3 — spawn-directory-dedup").** The
 * daemon does not otherwise track which directory a live session runs in,
 * so nothing stops two wizard submissions (or a retried RPC with a fresh
 * `idempotencyKey`, since idempotency-key replay only dedups an *exact*
 * retry) from launching two independent provider processes in the same
 * directory. AFTER workspace validation resolves `realDirectory` AND (when
 * `params.branch` is set) branch/worktree resolution has picked the final
 * `spawnDirectory` — but before any launch — `deps.
 * findLiveSessionInDirectory` (when supplied) is consulted against
 * `spawnDirectory`; a match returns that session's existing `sessionId`
 * instead of spawning a duplicate. Keying on the *final* directory (not the
 * pre-worktree `realDirectory`, docs/features/worktree-isolation.md Phase 3)
 * is what makes dedup actually protect the directory the session runs in —
 * repo root for repo-root spawns, `.worktrees/<branch>` for worktree spawns
 * — at the cost of two worktree-mode submissions for the *same* branch never
 * deduping against a *third* submission at the bare repo root; checking
 * after `ensureBranchWorkspace` (itself idempotent) is safe, since creating/
 * reusing the worktree before discovering a live session there has no
 * side effect worth avoiding. The daemon composition (`machineIntegration.ts`)
 * wires `findLiveSessionInDirectory` to a scan of the session registry's
 * `getSessions()` for a live `TrackedSession` whose `directory` matches
 * (`scanForLiveSessionInDirectory` below) — this module stays
 * registry-agnostic, same "injected seam" convention as
 * `resolveWorkspaceRoot`. Symmetrically, `deps.trackSpawned` (when supplied)
 * is called with the launched pid and `spawnDirectory` right after a
 * successful launch, so a *later* spawn's dedup scan can find THIS session —
 * mirrors `resumeSession.ts`'s own `registry.trackSpawned(launched.pid)`
 * call after its relaunch.
 */
import { fileURLToPath } from "node:url";
import type { SpawnParams, SpawnResult } from "@falcon/wire";
import type { Logger } from "../logger.js";
import { expandEnvVars } from "./envExpand.js";
import { ensureBranchWorkspace, type GitWorktreeDeps } from "./gitWorktree.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
} from "./processLauncher.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";
import type { ProcessExitWatcher, TrackedSession } from "./types.js";
import { validateSpawnWorkspace, type WorkspaceRootLookup } from "./workspacePath.js";

/** Thrown for any failure along the spawn path — validation, env expansion, launch, or the post-launch webhook wait. */
export class SpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnError";
  }
}

const PROVIDER_CLI_NAME: Record<SpawnParams["provider"], string> = {
  "claude-code": "claude",
  codex: "codex",
};

export interface SpawnEngineDeps {
  /** Resolves a workspace's registered root directory; `null`/`undefined` rejects the spawn (design §12). */
  resolveWorkspaceRoot: WorkspaceRootLookup;
  /** Matches the launched process's pid to its `/session-started` webhook. */
  awaiter: SpawnAwaiter;
  /** Extra env vars merged into the spawned process's environment; values may reference `${VAR}`, resolved against `baseEnv` (`envExpand.ts`). */
  envTemplate?: Record<string, string>;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to the real `launchProviderProcess`. */
  launchProcess?: typeof launchProviderProcessDefault;
  launchDeps?: LaunchProcessDeps;
  /** Injectable for tests; defaults to the real `git` binary (`gitWorktree.ts`). */
  gitWorktreeDeps?: GitWorktreeDeps;
  /** Returns the argv that re-invokes this same falcon binary, e.g. `[process.execPath, ...process.execArgv, entry]`. Injectable for tests. */
  falconEntrypoint?: () => string[];
  /**
   * Looks up a live tracked session already running in `realDirectory`
   * (the validated, resolved spawn target), if any — the directory-dedup
   * guard (plan.md §16 "Flow 3 — spawn-directory-dedup"). Returns its
   * `sessionId`, or `null`/`undefined` for "no live session there, proceed
   * with a normal spawn." Undefined means "no dedup guard configured" —
   * `spawnSession` always performs a real spawn attempt in that case,
   * matching every other optional dep here. `machineIntegration.ts` wires
   * the real default (a scan of the session registry's `getSessions()`,
   * `scanForLiveSessionInDirectory` below).
   */
  findLiveSessionInDirectory?: (realDirectory: string) => string | null | undefined;
  /**
   * Records a newly-launched pid's directory right after a successful
   * launch, so a LATER spawn's `findLiveSessionInDirectory` scan can find
   * this one (plan.md §16 "Flow 3 — spawn-directory-dedup"). Mirrors
   * `sessionRegistry.ts`'s `trackSpawned` exactly — `machineIntegration.ts`
   * wires it straight to `registry.trackSpawned`. Optional: tests that don't
   * care about dedup can simply omit it.
   */
  trackSpawned?: (pid: number, directory: string) => void;
  /**
   * Fire-and-forget setup-script kickoff (docs/features/
   * setup-run-scripts.md Phase 2) — called with `(workspaceRoot,
   * spawnDirectory)` exactly once, right after `ensureBranchWorkspace`
   * reports a genuine fresh worktree creation (`createdWorktree: true`),
   * never on a reused/idempotent worktree, an in-place checkout, or a
   * no-branch spawn. Not awaited: `spawnSession` must not block on an
   * arbitrary-length setup script under the RPC pipeline's ack timeout.
   * `machineIntegration.ts` wires the real default
   * (`setupScript.ts`'s `runSetupScript`, bound to this boot's
   * `homeDir`/`logger`) — tests that don't care about setup scripts can
   * simply omit it.
   */
  runSetupScript?: (workspaceRoot: string, spawnDirectory: string) => void;
  /**
   * A5 (docs/known-issues.md #8's sibling gap — "orphaned active session
   * rows when the process dies after DB-row creation, on an otherwise-
   * healthy machine"): called once, right after this spawn's `sessionId` is
   * known (the `/session-started` webhook landed), with a `watchExit`
   * subscribed to the SAME launched process for the rest of its life —
   * letting the caller (`machineIntegration.ts`) notice if that process
   * later dies WITHOUT the session's own clean `POST /v1/sessions/:id/
   * status` report ever landing (e.g. an ACP adapter connection failure
   * that throws instead of returning a reportable exit code — see that
   * module's own doc comment for the full failure-matrix reasoning).
   * Optional: a caller that doesn't care about this longer-lived tracking
   * (most tests) can simply omit it.
   */
  onSessionTracked?: (sessionId: string, watchExit: ProcessExitWatcher) => void;
  logger?: Logger;
}

/**
 * The real default `findLiveSessionInDirectory` implementation: scans a
 * session registry's already-live `TrackedSession[]` for one whose
 * `directory` matches `realDirectory` and that still carries a `sessionId`
 * (a session tracked pre-webhook, i.e. `trackSpawned` was called but
 * `/session-started` hasn't landed yet, has no `sessionId` yet and can't be
 * dedup'd against — the next spawn attempt would just race it, so this
 * intentionally only matches sessions the daemon has actually heard back
 * from). Exported standalone so it's unit-testable without standing up a
 * real registry (plan.md §16 "Flow 3 — spawn-directory-dedup" testing
 * notes).
 */
export function scanForLiveSessionInDirectory(
  sessions: TrackedSession[],
  realDirectory: string,
): string | null {
  for (const session of sessions) {
    if (session.sessionId && session.directory === realDirectory) {
      return session.sessionId;
    }
  }
  return null;
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

function buildProviderArgs(params: SpawnParams): string[] {
  const providerCliName = PROVIDER_CLI_NAME[params.provider];
  const args = [providerCliName, "--starting-mode", "remote", "--started-by", "daemon"];
  args.push("--permission-mode", params.permissionMode);
  if (params.model) args.push("--model", params.model);
  if (params.continueFrom) args.push("--continue-from", params.continueFrom.providerSessionId);
  return args;
}

export async function spawnSession(
  params: SpawnParams,
  deps: SpawnEngineDeps,
): Promise<SpawnResult> {
  const logger = deps.logger ?? noopLogger;
  const baseEnv = deps.baseEnv ?? process.env;

  const validation = await validateSpawnWorkspace(params, deps.resolveWorkspaceRoot);
  if (!validation.ok) {
    if (validation.reason === "not-found") {
      logger.info("[spawn-engine] target directory does not exist, requesting approval", {
        directory: params.directory,
      });
      return {
        requiresApproval: { action: "create-directory", directory: params.directory },
      };
    }
    if (validation.reason === "unknown-workspace") {
      // The user picked a folder never registered from a terminal. Rather
      // than a dead-end error, surface the same approval loop the missing-
      // directory case uses — the web confirms "register this folder as a
      // workspace?", registers it (a deliberate designation act, preserving
      // design §12's consent boundary), and retries spawn with the same key.
      logger.info(
        "[spawn-engine] workspaceId is not a registered workspace, requesting registration approval",
        { workspaceId: params.workspaceId, directory: params.directory },
      );
      return {
        requiresApproval: { action: "register-workspace", directory: params.directory },
      };
    }
    throw new SpawnError(`workspace path rejected (${validation.reason}): ${params.directory}`);
  }

  let spawnDirectory = validation.realDirectory;
  if (params.branch) {
    try {
      const branchResult = await ensureBranchWorkspace(
        { repoDirectory: validation.realDirectory, branch: params.branch },
        deps.gitWorktreeDeps,
      );
      spawnDirectory = branchResult.directory;
      // Fire-and-forget setup-script kickoff (docs/features/
      // setup-run-scripts.md Phase 2) — ONLY on a genuine fresh-worktree
      // creation, never on a retried/idempotent spawn that reuses an
      // existing worktree, an in-place checkout, or a no-branch spawn. Never
      // awaited: the RPC pipeline's 30s/35s ack timeouts forbid blocking
      // spawn on an arbitrary-length `npm install`. `deps.runSetupScript`
      // itself must never throw synchronously (see its own doc comment) —
      // this call site doesn't (and can't) catch a rejection from a
      // fire-and-forget call.
      if (branchResult.createdWorktree) {
        deps.runSetupScript?.(validation.realDirectory, spawnDirectory);
      }
    } catch (error) {
      throw new SpawnError(
        `branch/worktree setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Dedup must protect the directory the session will actually run in —
  // repo root for repo-root spawns, `.worktrees/<branch>` for worktree
  // spawns — so this is checked against `spawnDirectory` (the *final*,
  // post-branch-resolution target), not `validation.realDirectory` (plan.md
  // §16 "Flow 3 — spawn-directory-dedup", docs/features/worktree-isolation.md
  // Phase 3). Checking after `ensureBranchWorkspace` is safe: that call is
  // idempotent, so creating/reusing the worktree before discovering an
  // existing live session there never has a side effect worth avoiding.
  const existingSessionId = deps.findLiveSessionInDirectory?.(spawnDirectory);
  if (existingSessionId) {
    // A live session is already tracked in this exact directory — return it
    // instead of launching a second, competing process there.
    logger.info(
      "[spawn-engine] a live session already exists in this directory, returning it instead of spawning a duplicate",
      { directory: spawnDirectory, sessionId: existingSessionId },
    );
    return { sessionId: existingSessionId };
  }

  const expanded = expandEnvVars(deps.envTemplate ?? {}, baseEnv);
  if (!expanded.ok) {
    throw new SpawnError(
      `env template references unresolved variable(s): ${expanded.unresolved.join(", ")}`,
    );
  }

  const [command, ...prefixArgs] = deps.falconEntrypoint?.() ?? defaultFalconEntrypoint();
  if (!command) {
    throw new SpawnError("could not resolve the falcon entrypoint to re-invoke");
  }
  const args = [...prefixArgs, ...buildProviderArgs(params)];

  const launch = deps.launchProcess ?? launchProviderProcessDefault;
  let launched: Awaited<ReturnType<typeof launchProviderProcessDefault>>;
  try {
    launched = await launch(
      {
        sessionLabel: params.idempotencyKey,
        command,
        args,
        cwd: spawnDirectory,
        env: { ...baseEnv, ...expanded.env },
      },
      deps.launchDeps,
    );
  } catch (error) {
    throw new SpawnError(
      `failed to launch provider process: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  deps.trackSpawned?.(launched.pid, spawnDirectory);

  logger.info("[spawn-engine] launched provider process", {
    method: launched.method,
    pid: launched.pid,
    directory: spawnDirectory,
  });

  try {
    // A3: hand the launched process's real exit signal through so the
    // awaiter can reject fast on a dead child instead of always waiting out
    // the full timeout (`spawnAwaiter.ts`'s own doc comment has the full
    // rationale).
    const started = await deps.awaiter.waitFor(launched.pid, { watchExit: launched.watchExit });
    // A5: hand the SAME watchExit to the caller for the rest of this
    // process's life, now that we know its sessionId — this is what lets
    // the daemon notice a later, unreported death (not just a spawn-phase
    // one, which `spawnAwaiter` above already covers).
    deps.onSessionTracked?.(started.sessionId, launched.watchExit);
    return { sessionId: started.sessionId };
  } catch (error) {
    throw new SpawnError(
      `spawn launched (pid ${launched.pid}, ${launched.method}) but ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
