/**
 * Runs a workspace's configured `setupScript` (`falcon workspace config
 * --setup-script <script>`, docs/features/setup-run-scripts.md Phase 2) —
 * fire-and-forget, never blocking the caller on the script's completion.
 * Two callers: `spawnEngine.ts`'s post-`ensureBranchWorkspace` hook (only on
 * a genuine fresh-worktree creation) and the `run.setup` machine RPC
 * (`runProcess.ts`, Phase 3 — "re-run setup" from the web panel).
 *
 * **Config vs. cwd split:** `workspaceRoot` is the key `workspaceConfig.ts`
 * stores `setupScript` under (a worktree directory is never itself a config
 * key — only the containing repo root is); `directory` is where the script
 * actually runs (the worktree, when one was created). The persisted
 * run-state entry (`runStateStore.ts`) is keyed on `directory`, not
 * `workspaceRoot` — each worktree gets its own independent setup run.
 *
 * **Never throws, never blocks.** Every code path — bad config read, spawn
 * failure, a child that errors after spawning — is caught and recorded as a
 * terminal `failed` state rather than propagated, and the returned promise
 * resolves as soon as the child is launched (or the no-op/double-start
 * decision is made), never once the script itself finishes. This is a hard
 * requirement, not a nicety: `spawnEngine.ts` calls this fire-and-forget
 * with nothing awaiting a rejection, so a synchronous throw here would
 * become a silent, unobservable unhandled rejection that hides a setup
 * failure entirely.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { appendFileSync } from "node:fs";
import crossSpawnDefault from "cross-spawn";
import type { Logger } from "../logger.js";
import { readWorkspaceGitConfig, resolveWorkspaceKey } from "../workspaceConfig.js";
import { createFreshLogFile, setupLogFilePath } from "./runLogPaths.js";
import {
  readDirectoryRunState,
  type SetupState,
  updateDirectoryRunState,
} from "./runStateStore.js";
import { buildShellInvocation } from "./shellCommand.js";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RunSetupScriptParams {
  /** The registered workspace root — `workspaceConfig.ts`'s config key. */
  workspaceRoot: string;
  /** The directory the script actually runs in — the worktree, or `workspaceRoot` itself for a repo-root spawn. */
  directory: string;
}

export interface RunSetupScriptDeps {
  homeDir: string;
  logger?: Logger;
  /** Injectable for tests; defaults to `cross-spawn`. */
  spawnImpl?: SpawnFn;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests; defaults to a real `process.kill(pid, 0)` probe. */
  isAlive?: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunSetupScriptResult {
  started: boolean;
  alreadyRunning?: boolean;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    return true;
  }
}

function appendLog(logFile: string, chunk: Buffer): void {
  try {
    appendFileSync(logFile, chunk);
  } catch {
    // Best-effort: a log-write failure must not crash the setup run or the
    // daemon — the script's own exit code is still recorded regardless.
  }
}

/**
 * Kicks off `workspaceRoot`'s configured `setupScript` in `directory`.
 * Resolves quickly with `{started}` once the child is launched (or a no-op/
 * double-start decision is made) — never waits for the script to finish.
 */
export async function runSetupScript(
  params: RunSetupScriptParams,
  deps: RunSetupScriptDeps,
): Promise<RunSetupScriptResult> {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const isAlive = deps.isAlive ?? defaultIsAlive;

  try {
    const config = await readWorkspaceGitConfig(params.workspaceRoot, { homeDir: deps.homeDir });
    const script = config?.setupScript;
    if (!script) {
      logger.debug("[setup-script] no setupScript configured, skipping", {
        workspaceRoot: params.workspaceRoot,
      });
      return { started: false };
    }

    const directoryKey = await resolveWorkspaceKey(params.directory);

    const persisted = await readDirectoryRunState(deps.homeDir, directoryKey);
    if (
      persisted?.setup?.state === "running" &&
      persisted.setup.pid !== undefined &&
      isAlive(persisted.setup.pid)
    ) {
      logger.info("[setup-script] a setup run is already in progress for this directory", {
        directory: params.directory,
      });
      return { started: false, alreadyRunning: true };
    }

    const startedAt = now();
    const logFile = setupLogFilePath(deps.homeDir, directoryKey);
    await createFreshLogFile(logFile);

    const invocation = buildShellInvocation(script);
    const spawnImpl = deps.spawnImpl ?? (crossSpawnDefault as unknown as SpawnFn);

    let child: ChildProcess;
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd: params.directory,
        env: deps.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[setup-script] failed to spawn setup script", {
        directory: params.directory,
        message,
      });
      await updateDirectoryRunState(deps.homeDir, directoryKey, {
        setup: { state: "failed", startedAt, finishedAt: now(), logFile },
      });
      return { started: false };
    }

    await updateDirectoryRunState(deps.homeDir, directoryKey, {
      setup: { state: "running", pid: child.pid, startedAt, logFile },
    });

    child.stdout?.on("data", (chunk: Buffer) => appendLog(logFile, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendLog(logFile, chunk));

    child.once("error", (error) => {
      logger.error("[setup-script] setup script process error", {
        directory: params.directory,
        message: error.message,
      });
      updateDirectoryRunState(deps.homeDir, directoryKey, {
        setup: { state: "failed", startedAt, finishedAt: now(), logFile },
      }).catch(() => {});
    });

    child.once("close", (code) => {
      const state: SetupState = code === 0 ? "succeeded" : "failed";
      logger.info("[setup-script] setup script finished", {
        directory: params.directory,
        state,
        exitCode: code,
      });
      updateDirectoryRunState(deps.homeDir, directoryKey, {
        setup: {
          state,
          exitCode: code === null ? undefined : code,
          startedAt,
          finishedAt: now(),
          logFile,
        },
      }).catch(() => {});
    });

    return { started: true };
  } catch (error) {
    // Absolute guarantee: this function must never throw or reject
    // synchronously — see this module's header comment.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[setup-script] unexpected error kicking off setup script", { message });
    return { started: false };
  }
}
