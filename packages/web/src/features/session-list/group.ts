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

/** Pinned sessions first, then most-recently-updated first within each of
 * those two groups — applies uniformly to every bucket, including the
 * ungrouped one. */
export function byPinnedThenUpdatedAtDesc(a: SessionListSession, b: SessionListSession): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

/** The group-level "most recently active" key. Deliberately the MAX
 * `updatedAt` across every session in the group, not `sessions[0]`'s —
 * since the pinned-first sort above means `sessions[0]` can be an old
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
 * worktree child re-parents onto its parent repo only
 * when that parent is itself a known, registered workspace; otherwise it
 * stays its own top-level group rather than inventing one for an
 * unregistered parent.
 *
 * Re-parenting itself needs the REAL path (`.worktrees/<branch>` detection),
 * never `workspaceId` — an opaque `workspaces.id` — so this looks up the
 * session's own workspace's decrypted `path`, and matches candidate parents
 * by THEIR decrypted `path` too (`pathToWorkspaceId`). A workspace whose path
 * hasn't decrypted yet (`path: null`) just can't be re-parented this pass —
 * it stays its own top-level group until decryption catches up, rather than
 * guessing.
 */
function resolveBucketKey(
  workspaceId: string | null,
  workspaceById: Map<string, SessionListWorkspace>,
  pathToWorkspaceId: Map<string, string>,
): string {
  if (workspaceId === null || !workspaceById.has(workspaceId)) return UNGROUPED_WORKSPACE_ID;
  const path = workspaceById.get(workspaceId)?.path;
  const parentPath = path ? parentWorktreePath(path) : null;
  const parentId = parentPath ? pathToWorkspaceId.get(parentPath) : undefined;
  return parentId ?? workspaceId;
}

/** Reverse lookup of `SessionListWorkspace.path` → `.id`, for
 * `resolveBucketKey`'s re-parenting — built once per grouping pass rather
 * than scanning `workspaces` per session. */
function buildPathToWorkspaceId(workspaces: readonly SessionListWorkspace[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const w of workspaces) {
    if (w.path) map.set(w.path, w.id);
  }
  return map;
}

/**
 * Groups sessions by workspace and sorts each group's sessions pinned-first,
 * then by most recently updated. Group order: workspaces with at least one
 * session, most-recently-active session first, then the ungrouped bucket
 * last (if non-empty).
 */
export function groupSessionsByWorkspace(snapshot: SessionListSnapshot): WorkspaceGroup[] {
  const workspaceById = new Map(snapshot.workspaces.map((w) => [w.id, w]));
  const pathToWorkspaceId = buildPathToWorkspaceId(snapshot.workspaces);
  const buckets = new Map<string, SessionListSession[]>();

  for (const session of snapshot.sessions) {
    const key = resolveBucketKey(session.workspaceId, workspaceById, pathToWorkspaceId);
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
      workspace: { id: UNGROUPED_WORKSPACE_ID, name: "Other sessions", path: null },
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
  const pathToWorkspaceId = buildPathToWorkspaceId(workspaces);
  const order: string[] = [];
  const buckets = new Map<string, SessionListSession[]>();

  for (const session of sessions) {
    const key = resolveBucketKey(session.workspaceId, workspaceById, pathToWorkspaceId);
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
        ? { id: UNGROUPED_WORKSPACE_ID, name: "Other sessions", path: null }
        : (workspaceById.get(id) as SessionListWorkspace),
    sessions: [...(buckets.get(id) ?? [])].sort(byPinnedThenUpdatedAtDesc),
  }));
}
