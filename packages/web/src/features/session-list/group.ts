import type { SessionListSession, SessionListSnapshot, SessionListWorkspace } from "./types";

/** One workspace's sessions, newest activity first (design §9.2 "Home" row:
 * "`SessionList` grouped by workspace"). */
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

function byUpdatedAtDesc(a: SessionListSession, b: SessionListSession): number {
  return b.updatedAt - a.updatedAt;
}

/**
 * Groups sessions by workspace and sorts each group's sessions by most
 * recently updated first. Group order: workspaces with at least one session,
 * most-recently-active session first, then the ungrouped bucket last (if
 * non-empty).
 */
export function groupSessionsByWorkspace(snapshot: SessionListSnapshot): WorkspaceGroup[] {
  const workspaceById = new Map(snapshot.workspaces.map((w) => [w.id, w]));
  const buckets = new Map<string, SessionListSession[]>();

  for (const session of snapshot.sessions) {
    const key =
      session.workspaceId !== null && workspaceById.has(session.workspaceId)
        ? session.workspaceId
        : UNGROUPED_WORKSPACE_ID;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [id, sessions] of buckets) {
    if (id === UNGROUPED_WORKSPACE_ID) continue;
    const workspace = workspaceById.get(id);
    if (!workspace) continue; // unreachable given the bucketing above, but keeps this total
    groups.push({ workspace, sessions: [...sessions].sort(byUpdatedAtDesc) });
  }
  groups.sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));

  const ungrouped = buckets.get(UNGROUPED_WORKSPACE_ID);
  if (ungrouped && ungrouped.length > 0) {
    groups.push({
      workspace: { id: UNGROUPED_WORKSPACE_ID, name: "Other sessions" },
      sessions: [...ungrouped].sort(byUpdatedAtDesc),
    });
  }

  return groups;
}
