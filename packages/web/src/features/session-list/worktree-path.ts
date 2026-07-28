/**
 * Pure predicate mirroring the daemon's own `worktreeRemove.ts`'s
 * `assertLooksLikeWorktreeDir` safety check (Phase C, new-session-from-web
 * redesign — see that module's doc comment for the full "why"): a session's
 * `workspaceId` is only ever safe to offer "Remove worktree" for when it's a
 * Falcon-managed `.worktrees/<branch>` directory, not a plain repo root.
 *
 * This is a UX-layer mirror, not the actual security boundary — the daemon
 * RPC re-checks this itself (and MUST, since a web client's own gating is
 * trivially bypassable), but showing the menu item at all for a ordinary
 * repo-root session would be actively misleading (implying there's a
 * worktree to clean up when there isn't one), so it's worth getting right
 * client-side too, and worth its own direct unit test rather than only
 * being implicitly covered by the daemon test.
 */
export function looksLikeWorktreePath(workspaceId: string | null): boolean {
  if (workspaceId === null) return false;
  return workspaceId.split(/[/\\]/).includes(".worktrees");
}
