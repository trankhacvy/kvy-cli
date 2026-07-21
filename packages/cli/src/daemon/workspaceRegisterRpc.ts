/**
 * Backs the daemon's `workspace.register` machine RPC (plan.md §16 "Flow 3
 * — spawn-fresh-folder-register (Piece A)", `@falcon/wire`'s
 * `WorkspaceRegisterParams`/`Result`).
 *
 * Thin wrapper around the already-real, already-idempotent
 * `workspace/registry.ts`'s `registerWorkspace` — the same store
 * `workspacePath.ts`'s `WorkspaceRootLookup` validates `spawn` requests
 * against (`workspace/adapters.ts`'s `createWorkspaceRootLookup`). This is
 * deliberately its own module rather than folded into `fsBrowse.ts`
 * (`fs.list`/`fs.mkdir`): those two are intentionally NOT scoped to a
 * registered workspace root (design §12's directory-picker carve-out —
 * "the user is choosing which directory *becomes* a workspace"), whereas
 * this RPC is the actual, explicit act of designation that turns a picked
 * directory into one. Registered as a real, dependency-free default in
 * `machineRpc.ts` — same "no extra wiring needed" precedent as `fs.list`/
 * `fs.mkdir`'s own defaults there.
 */
import type { WorkspaceRegisterParams, WorkspaceRegisterResult } from "@falcon/wire";
import { registerWorkspace as registerWorkspaceCore } from "../workspace/registry.js";

/** Registers `params.directory` as a workspace. Idempotent — registering an already-registered directory is a safe no-op (`registry.ts`'s own contract). Throws only if the underlying registry write fails (e.g. lock-acquisition timeout). */
export async function registerWorkspace(
  params: WorkspaceRegisterParams,
): Promise<WorkspaceRegisterResult> {
  await registerWorkspaceCore(params.directory);
  return { ok: true };
}
