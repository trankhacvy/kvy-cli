/**
 * `workspace.getConfig` machine RPC handler (docs/features/
 * setup-run-scripts.md Phase 3/4): read-only surface for the web Workspace
 * Settings UI to *see* the configured `baseRef`/`remote`/`setupScript`/
 * `runScript` — `workspaceConfig.ts`'s store previously had no daemon
 * surface at all (`falcon workspace config` is CLI-only, "no daemon
 * interaction"). Definition stays CLI-only (design §12's local-consent
 * boundary, this feature's central risk note) — there is deliberately no
 * `workspace.setConfig` RPC; adding one would reopen the "remote code
 * execution via a script string over the wire" risk this handler is
 * designed to avoid.
 *
 * Gated on the same registered-workspace authorizer as every `run.*`
 * handler (`runProcess.ts`'s `resolveRunContext`) — read-only, but still
 * scoped to worktrees the user has actually designated as a Falcon
 * workspace.
 */
import type { WorkspaceGetConfigParams, WorkspaceGetConfigResult } from "@falcon/wire";
import { resolveHomeDir } from "../home.js";
import { readWorkspaceGitConfig } from "../workspaceConfig.js";
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
