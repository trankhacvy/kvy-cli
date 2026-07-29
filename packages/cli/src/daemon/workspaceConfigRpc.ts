/**
 * `workspace.getConfig`/`workspace.setConfig` machine RPC handlers
 * (docs/features/setup-run-scripts.md Phase 3/4): the web Workspace
 * Settings UI's surface for the configured `baseRef`/`remote`/
 * `setupScript`/`runScript` — `workspaceConfig.ts`'s store previously had
 * no daemon surface at all (`falcon workspace config` is CLI-only, "no
 * daemon interaction"). Script *definition* stays CLI-only (design §12's
 * local-consent boundary, this feature's central risk note): `setConfig`'s
 * params schema (`@falcon/wire`'s `WorkspaceSetConfigParamsSchema`)
 * carries only `baseRef`/`remote` — never `setupScript`/`runScript` —
 * exactly so this RPC can't reopen the "remote code execution via a script
 * string over the wire" risk `getConfig`'s read-only design avoided.
 *
 * Both gated on the same registered-workspace authorizer as every `run.*`
 * handler (`runProcess.ts`'s `resolveRunContext`) — scoped to worktrees the
 * user has actually designated as a Falcon workspace.
 */
import type {
  WorkspaceGetConfigParams,
  WorkspaceGetConfigResult,
  WorkspaceSetConfigParams,
  WorkspaceSetConfigResult,
} from "@falcon/wire";
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

/** `workspace.setConfig` machine RPC handler. Throws (via `resolveRunContext`) when the worktree isn't inside a registered workspace. Only patches `baseRef`/`remote` — see this module's doc comment for why scripts never reach this handler. */
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
