/**
 * Shared seam: resolve a bare provider session id (as carried on
 * `adopt.take`/`adopt.mirror` RPC params) back to "which registered
 * workspace is this transcript in" — both the takeover RPC
 * (`adoptTake.ts`, to find the owning pid and to build the re-spawn's
 * `SpawnParams`) and the read-only mirror RPC (`transcriptMirror.ts`, to
 * locate the transcript file) need this exact lookup.
 *
 * No real default is provided here, on purpose — same as
 * `workspacePath.ts`'s `resolveWorkspaceRoot` and
 * `transcriptIndexer.ts`'s `listWorkspaces`: the daemon-side bookkeeping
 * for "which workspace paths/ids are registered on this machine" is a
 * separate, later task (plan.md §16 "3.1 Remote spawn"'s workspace
 * registry). Callers wire a real implementation once that lands.
 */

export interface ResolvedProviderSession {
  workspaceId: string;
  /** Absolute working-directory path Claude Code was run in for this provider session. */
  directory: string;
}

export type ProviderSessionResolver = (
  providerSessionId: string,
) => Promise<ResolvedProviderSession | null>;
