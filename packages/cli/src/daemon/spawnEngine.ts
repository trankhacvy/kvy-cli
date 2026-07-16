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
 */
import { fileURLToPath } from "node:url";
import type { SpawnParams, SpawnResult } from "@falcon/wire";
import type { Logger } from "../logger.js";
import { expandEnvVars } from "./envExpand.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
} from "./processLauncher.js";
import type { SpawnAwaiter } from "./spawnAwaiter.js";
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
  /** Returns the argv that re-invokes this same falcon binary, e.g. `[process.execPath, ...process.execArgv, entry]`. Injectable for tests. */
  falconEntrypoint?: () => string[];
  logger?: Logger;
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
    throw new SpawnError(`workspace path rejected (${validation.reason}): ${params.directory}`);
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
        cwd: validation.realDirectory,
        env: { ...baseEnv, ...expanded.env },
      },
      deps.launchDeps,
    );
  } catch (error) {
    throw new SpawnError(
      `failed to launch provider process: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logger.info("[spawn-engine] launched provider process", {
    method: launched.method,
    pid: launched.pid,
    directory: validation.realDirectory,
  });

  try {
    const started = await deps.awaiter.waitFor(launched.pid);
    return { sessionId: started.sessionId };
  } catch (error) {
    throw new SpawnError(
      `spawn launched (pid ${launched.pid}, ${launched.method}) but ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
