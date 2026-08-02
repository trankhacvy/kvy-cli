/**
 * `workspace.getConfig`/`workspace.setConfig` machine RPC handlers.
 *
 * `setConfig` only patches `baseRef`/`remote` — never `setupScript`/`runScript`.
 * Script definition is intentionally CLI-only (local consent boundary): allowing
 * script strings over the wire would open a remote-code-execution risk.
 */
import type {
  WorkspaceGetConfigParams,
  WorkspaceGetConfigResult,
  WorkspaceSetConfigParams,
  WorkspaceSetConfigResult,
} from "@kvy/wire";
import { resolveHomeDir } from "../home.js";
import { readWorkspaceGitConfig, setWorkspaceGitConfig } from "../workspaceConfig.js";
import { type RunProcessDeps, resolveRunContext } from "./runProcess.js";

/** `workspace.getConfig` machine RPC handler. Throws (via `resolveRunContext`) when the worktree isn't inside a registered workspace. */
export async function handleWorkspaceGetConfig(
  params: WorkspaceGetConfigParams,
  deps: RunProcessDeps = {},
): Promise<WorkspaceGetConfigResult> {
  const homeDir = deps.homeDir ?? resolveHomeDir(process.env);
  const context = await resolveRunContext(params.worktree, deps.registryOptions ?? { homeDir });
  const config = await readWorkspaceGitConfig(context.workspaceRoot, { homeDir });
  return {
    baseRef: config?.baseRef,
    remote: config?.remote,
    setupScript: config?.setupScript,
    runScript: config?.runScript,
  };
}

/** `workspace.setConfig` machine RPC handler. Throws (via `resolveRunContext`) when the worktree isn't inside a registered workspace. Only patches `baseRef`/`remote`. */
export async function handleWorkspaceSetConfig(
  params: WorkspaceSetConfigParams,
  deps: RunProcessDeps = {},
): Promise<WorkspaceSetConfigResult> {
  const homeDir = deps.homeDir ?? resolveHomeDir(process.env);
  const context = await resolveRunContext(params.worktree, deps.registryOptions ?? { homeDir });
  const config = await setWorkspaceGitConfig(
    context.workspaceRoot,
    { baseRef: params.baseRef, remote: params.remote },
    { homeDir },
  );
  return { baseRef: config.baseRef, remote: config.remote };
}
