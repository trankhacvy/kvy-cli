/**
 * Real default implementations of the injected "which workspaces does this
 * machine know about" seams, built on top of `./registry.ts`. Each of these
 * seams was deliberately left with no real default by the task that
 * introduced it, precisely so a later, standalone registry could be handed
 * in without those tasks guessing at its shape:
 *
 *  - `daemon/workspacePath.ts`'s `WorkspaceRootLookup` (used by `spawn`'s
 *    `validateSpawnWorkspace`) → `createWorkspaceRootLookup` below.
 *  - `daemon/transcriptIndexer.ts`'s `TranscriptIndexerDeps.listWorkspaces`
 *    → `createTranscriptIndexerWorkspaceLister` below.
 *
 * Not adapted here (see this task's summary for why): `daemon/
 * providerSessionResolver.ts`'s `ProviderSessionResolver` — resolving a bare
 * provider session id back to a workspace additionally requires scanning
 * transcript contents (which workspace's transcript directory contains this
 * session id), not just "which directories are registered"; that's a
 * different, later composition, not this registry's job. Wiring any of
 * these adapters into a live daemon boot sequence (`daemon/commands.ts`) is
 * also out of scope, matching the precedent already set by
 * `P3-3.1-daemon-spawn-rpc`/`P3-3.3-session-adoption-indexer`.
 */
import type { RegisteredWorkspace } from "../daemon/transcriptIndexer.js";
import type { WorkspaceRootLookup } from "../daemon/workspacePath.js";
import { listWorkspaces, type RegistryOptions } from "./registry.js";

/**
 * `workspaceId` in this codebase *is* a workspace's registered (real,
 * symlink-resolved) directory path — see `registry.ts`'s module doc. So the
 * lookup is just "is this path currently registered", returning the same
 * path back as its own root (a workspace's root is itself).
 */
export function createWorkspaceRootLookup(options: RegistryOptions = {}): WorkspaceRootLookup {
  return async (workspaceId: string) => {
    const entries = await listWorkspaces(options);
    return entries.some((entry) => entry.path === workspaceId) ? workspaceId : null;
  };
}

/** Adapts the registry to `TranscriptIndexerDeps.listWorkspaces`'s `{workspaceId, path}` shape. */
export function createTranscriptIndexerWorkspaceLister(
  options: RegistryOptions = {},
): () => Promise<RegisteredWorkspace[]> {
  return async () => {
    const entries = await listWorkspaces(options);
    return entries.map((entry) => ({ workspaceId: entry.path, path: entry.path }));
  };
}
