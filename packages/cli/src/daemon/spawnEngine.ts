import type { SpawnParams, SpawnResult } from "@kvy/wire";
import { defaultKvyEntrypoint } from "../kvyEntrypoint.js";
import type { Logger } from "../logger.js";
import { PROVIDER_REGISTRY } from "../provider/registry.js";
import { expandEnvVars } from "./envExpand.js";
import { ensureBranchWorkspace, type GitWorktreeDeps } from "./gitWorktree.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
} from "./processLauncher.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";
import type { ProcessExitWatcher, TrackedSession } from "./types.js";
import { validateSpawnWorkspace, type WorkspaceRootLookup } from "./workspacePath.js";

/** Thrown for any failure along the spawn path: validation, env expansion, launch, or the post-launch webhook wait. */
export class SpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnError";
  }
}

export interface SpawnEngineDeps {
  /** Resolves a workspace's registered root directory; `null`/`undefined` rejects the spawn. */
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
  /** Returns the argv that re-invokes this same kvy binary, e.g. `[process.execPath, ...process.execArgv, entry]`. Injectable for tests. */
  kvyEntrypoint?: () => string[];
  /**
   * Looks up a live tracked session already running in `realDirectory`, if any.
   * Returns its `sessionId` to avoid double-spawning, or `null`/`undefined`
   * for "no live session there, proceed with a normal spawn."
   */
  findLiveSessionInDirectory?: (realDirectory: string) => string | null | undefined;
  /**
   * Records a newly-launched pid's directory so a later spawn's
   * `findLiveSessionInDirectory` scan can find this session. Optional.
   */
  trackSpawned?: (pid: number, directory: string) => void;
  /**
   * Fire-and-forget setup-script kickoff — called once on genuine fresh-worktree
   * creation, never on a reused worktree or no-branch spawn. Not awaited: must
   * not block spawn under the RPC pipeline's ack timeout. Optional.
   */
  runSetupScript?: (workspaceRoot: string, spawnDirectory: string) => void;
  /**
   * Called once the spawn's `sessionId` is known, with a `watchExit`
   * subscribed to the same process for the rest of its life — lets the caller
   * detect an unreported process death after session start. Optional.
   */
  onSessionTracked?: (sessionId: string, watchExit: ProcessExitWatcher) => void;
  logger?: Logger;
}

/**
 * Scans a session registry's live `TrackedSession[]` for one whose `directory`
 * matches `realDirectory` and that already has a `sessionId` (a pre-webhook
 * session tracked via `trackSpawned` but not yet reported back has no id and
 * cannot be dedup'd against). Exported for unit testing.
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

function buildProviderArgs(params: SpawnParams): string[] {
  const providerCliName = PROVIDER_REGISTRY[params.provider].kvySubcommand;
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
      // An unregistered workspace gets the same approval loop as a missing
      // directory — the web confirms, registers it, and retries with the same key.
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
      // Fire-and-forget setup-script kickoff — only on genuine fresh-worktree
      // creation, never on reused/idempotent worktrees or no-branch spawns.
      // Never awaited: must not block spawn on an arbitrary-length install.
      if (branchResult.createdWorktree) {
        deps.runSetupScript?.(validation.realDirectory, spawnDirectory);
      }
    } catch (error) {
      throw new SpawnError(
        `branch/worktree setup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Dedup is checked against `spawnDirectory` (the final, post-branch-resolution
  // target), not `validation.realDirectory` — dedup must protect the directory
  // the session actually runs in. Checking after `ensureBranchWorkspace` is
  // safe: that call is idempotent.
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

  const [command, ...prefixArgs] = deps.kvyEntrypoint?.() ?? defaultKvyEntrypoint();
  if (!command) {
    throw new SpawnError("could not resolve the kvy entrypoint to re-invoke");
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
    // Hand the launched process's exit watcher through so the awaiter can
    // reject fast if the child dies before reporting.
    const started = await deps.awaiter.waitFor(launched.pid, { watchExit: launched.watchExit });
    // Pass the same watchExit to the caller now that the sessionId is known,
    // so unreported deaths after the spawn phase can be noticed too.
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
