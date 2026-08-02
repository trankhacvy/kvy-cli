import type {
  WorkspaceRegisterParams,
  WorkspaceRegisterResult,
  WorkspaceUnregisterParams,
  WorkspaceUnregisterResult,
} from "@kvy/wire";
import {
  registerWorkspace as registerWorkspaceCore,
  unregisterWorkspace as unregisterWorkspaceCore,
} from "../workspace/registry.js";

/** Registers `params.directory` as a workspace. Idempotent. Throws only if the underlying registry write fails. */
export async function registerWorkspace(
  params: WorkspaceRegisterParams,
): Promise<WorkspaceRegisterResult> {
  await registerWorkspaceCore(params.directory);
  return { ok: true };
}

/** Removes `params.directory`'s registration. Idempotent. Throws only if the underlying registry write fails. */
export async function unregisterWorkspace(
  params: WorkspaceUnregisterParams,
): Promise<WorkspaceUnregisterResult> {
  await unregisterWorkspaceCore(params.directory);
  return { ok: true };
}
