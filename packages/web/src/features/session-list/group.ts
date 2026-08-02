import type { SessionListSession, SessionListSnapshot, SessionListWorkspace } from "./types";
import { parentWorktreePath } from "./worktree-path";

export interface WorkspaceGroup {
  workspace: SessionListWorkspace;
  sessions: SessionListSession[];
}

/** Sessions with no `workspaceId` (or one that doesn't resolve to a known
 * workspace) land here rather than being dropped — design principle: no
 * silent data loss. Maps to the design's `UnmanagedSection` idea, generalized
 * to "sessions we can't place in a workspace group" rather than only
 * takeover candidates. */
export const UNGROUPED_WORKSPACE_ID = "__ungrouped__";

/** Pinned sessions first (Pin — docs/features/session-lifecycle-actions.md
 * Phase 4), then most-recently-updated first within each of those two
 * groups — applies uniformly to every bucket, including the ungrouped one. */
export function byPinnedThenUpdatedAtDesc(a: SessionListSession, b: SessionListSession): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

/** The group-level "most recently active" key. Deliberately the MAX
 * `updatedAt` across every session in the group, not `sessions[0]`'s —
 * since Phase 4's pinned-first sort means `sessions[0]` can be an old
 * pinned session, which must not make a workspace with genuinely fresher
 * (but unpinned) activity sort BELOW a less-recently-active workspace. */
function mostRecentUpdatedAt(sessions: readonly SessionListSession[]): number {
  let max = 0;
  for (const session of sessions) {
    if (session.updatedAt > max) max = session.updatedAt;
  }
  return max;
}

/**
 * Resolves the bucket key a session's `workspaceId` groups under — a
 * worktree child re-parents onto its parent repo (known-issues.md #15) only
 * when that parent is itself a known, registered workspace; otherwise it
 * stays its own top-level group rather than inventing one for an
 * unregistered parent.
 */
function resolveBucketKey(
  workspaceId: string | null,
  workspaceById: Map<string, SessionListWorkspace>,
): string {
  if (workspaceId === null || !workspaceById.has(workspaceId)) return UNGROUPED_WORKSPACE_ID;
  const parentId = parentWorktreePath(workspaceId);
  return parentId && workspaceById.has(parentId) ? parentId : workspaceId;
}

/**
 * Groups sessions by workspace and sorts each group's sessions pinned-first,
 * then by most recently updated. Group order: workspaces with at least one
 * session, most-recently-active session first, then the ungrouped bucket
 * last (if non-empty).
 */
export function groupSessionsByWorkspace(snapshot: SessionListSnapshot): WorkspaceGroup[] {
  const workspaceById = new Map(snapshot.workspaces.map((w) => [w.id, w]));
  const buckets = new Map<string, SessionListSession[]>();

  for (const session of snapshot.sessions) {
    const key = resolveBucketKey(session.workspaceId, workspaceById);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [id, sessions] of buckets) {
    if (id === UNGROUPED_WORKSPACE_ID) continue;
    const workspace = workspaceById.get(id);
    if (!workspace) continue; // unreachable given the bucketing above, but keeps this total
    groups.push({ workspace, sessions: [...sessions].sort(byPinnedThenUpdatedAtDesc) });
  }
  groups.sort((a, b) => mostRecentUpdatedAt(b.sessions) - mostRecentUpdatedAt(a.sessions));

  const ungrouped = buckets.get(UNGROUPED_WORKSPACE_ID);
  if (ungrouped && ungrouped.length > 0) {
    groups.push({
      workspace: { id: UNGROUPED_WORKSPACE_ID, name: "Other sessions" },
      sessions: [...ungrouped].sort(byPinnedThenUpdatedAtDesc),
    });
  }

  return groups;
}

/**
 * Groups an already-selected, already-ordered slice of sessions (e.g. the top
 * N by `updatedAt` for one page of Home) by workspace, WITHOUT re-deriving
 * group order from recency — group order instead follows first-appearance in
 * `sessions`, so "page 1's top 10 by recency, clustered for readability"
 * doesn't get silently re-sorted back into whole-group recency order (that's
 * `groupSessionsByWorkspace`'s job for the unpaginated case; this is a
 * deliberately different, paging-aware sibling, not a replacement).
 */
export function groupPagedSessions(
  sessions: readonly SessionListSession[],
  workspaces: readonly SessionListWorkspace[],
): WorkspaceGroup[] {
  const workspaceById = new Map(workspaces.map((w) => [w.id, w]));
  const order: string[] = [];
  const buckets = new Map<string, SessionListSession[]>();

  for (const session of sessions) {
    const key = resolveBucketKey(session.workspaceId, workspaceById);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(session);
  }

  return order.map((id) => ({
    workspace:
      id === UNGROUPED_WORKSPACE_ID
        ? { id: UNGROUPED_WORKSPACE_ID, name: "Other sessions" }
        : (workspaceById.get(id) as SessionListWorkspace),
    sessions: [...(buckets.get(id) ?? [])].sort(byPinnedThenUpdatedAtDesc),
  }));
}
