import { describe, expect, it } from "vitest";
import { groupPagedSessions, groupSessionsByWorkspace, UNGROUPED_WORKSPACE_ID } from "./group";
import type { SessionListSession, SessionListSnapshot, SessionListWorkspace } from "./types";

function session(overrides: Partial<SessionListSession>): SessionListSession {
  return {
    id: "s1",
    workspaceId: "w1",
    path: null,
    machineId: "m1",
    title: "session",
    provider: "claude",
    status: "active",
    updatedAt: 0,
    pinned: false,
    items: [],
    attention: null,
    ...overrides,
  };
}

describe("groupSessionsByWorkspace", () => {
  it("groups sessions under their workspace and sorts each group newest-first", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy", path: "w1" }],
      machines: [],
      sessions: [
        session({ id: "old", workspaceId: "w1", updatedAt: 1 }),
        session({ id: "new", workspaceId: "w1", updatedAt: 5 }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspace.id).toBe("w1");
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("orders workspace groups by their most recently active session", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "stale", name: "stale-repo", path: "stale" },
        { id: "fresh", name: "fresh-repo", path: "fresh" },
      ],
      machines: [],
      sessions: [
        session({ id: "a", workspaceId: "stale", updatedAt: 1 }),
        session({ id: "b", workspaceId: "fresh", updatedAt: 100 }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups.map((g) => g.workspace.id)).toEqual(["fresh", "stale"]);
  });

  it("buckets sessions with no resolvable workspace into a trailing ungrouped group", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy", path: "w1" }],
      machines: [],
      sessions: [
        session({ id: "placed", workspaceId: "w1", updatedAt: 1 }),
        session({ id: "orphan-null", workspaceId: null, updatedAt: 2 }),
        session({ id: "orphan-unknown", workspaceId: "does-not-exist", updatedAt: 3 }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups).toHaveLength(2);
    const ungrouped = groups.at(-1);
    expect(ungrouped?.workspace.id).toBe(UNGROUPED_WORKSPACE_ID);
    expect(ungrouped?.sessions.map((s) => s.id).sort()).toEqual(["orphan-null", "orphan-unknown"]);
  });

  it("returns an empty array for an empty snapshot", () => {
    expect(groupSessionsByWorkspace({ workspaces: [], machines: [], sessions: [] })).toEqual([]);
  });

  it("sorts pinned sessions before unpinned ones, ahead of the updatedAt ordering", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "w1", name: "kvy", path: "w1" }],
      machines: [],
      sessions: [
        session({ id: "unpinned-new", workspaceId: "w1", updatedAt: 100, pinned: false }),
        session({ id: "pinned-old", workspaceId: "w1", updatedAt: 1, pinned: true }),
        session({ id: "unpinned-old", workspaceId: "w1", updatedAt: 2, pinned: false }),
        session({ id: "pinned-new", workspaceId: "w1", updatedAt: 50, pinned: true }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "unpinned-new",
      "unpinned-old",
    ]);
  });

  it("applies pinned-first ordering to the ungrouped bucket too", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [],
      machines: [],
      sessions: [
        session({ id: "unpinned", workspaceId: null, updatedAt: 10, pinned: false }),
        session({ id: "pinned", workspaceId: null, updatedAt: 1, pinned: true }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["pinned", "unpinned"]);
  });

  it("orders groups by their most recently active session even when pinning reorders that session out of slot 0", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "a", name: "workspace-a", path: "a" },
        { id: "b", name: "workspace-b", path: "b" },
      ],
      machines: [],
      sessions: [
        // workspace a: has a very recent unpinned session (5000), plus an old pinned one (100).
        session({ id: "a-pinned-old", workspaceId: "a", updatedAt: 100, pinned: true }),
        session({ id: "a-unpinned-new", workspaceId: "a", updatedAt: 5000, pinned: false }),
        // workspace b: only a moderately recent unpinned session (3000).
        session({ id: "b-unpinned", workspaceId: "b", updatedAt: 3000, pinned: false }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    // workspace a has the most recently active session overall (5000 > 3000)
    // so it must still sort first at the GROUP level, even though its
    // first SESSION (post pinned-first sort) is the old pinned one.
    expect(groups.map((g) => g.workspace.id)).toEqual(["a", "b"]);
  });

  it("re-parents a worktree child onto its registered parent repo", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "/repo", name: "repo", path: "/repo" },
        { id: "/repo/.worktrees/wf/a", name: "wf/a", path: "/repo/.worktrees/wf/a" },
      ],
      machines: [],
      sessions: [
        session({ id: "main", workspaceId: "/repo", updatedAt: 1 }),
        session({ id: "worktree-child", workspaceId: "/repo/.worktrees/wf/a", updatedAt: 2 }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspace.id).toBe("/repo");
    expect(groups[0]?.sessions.map((s) => s.id).sort()).toEqual(["main", "worktree-child"]);
  });

  it("leaves a worktree child top-level when its parent isn't a registered workspace", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [{ id: "/repo/.worktrees/wf/a", name: "wf/a", path: "/repo/.worktrees/wf/a" }],
      machines: [],
      sessions: [session({ id: "orphan-worktree", workspaceId: "/repo/.worktrees/wf/a" })],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspace.id).toBe("/repo/.worktrees/wf/a");
  });

  it("groups two sibling worktrees under the same registered parent", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "/repo", name: "repo", path: "/repo" },
        { id: "/repo/.worktrees/wf/a", name: "wf/a", path: "/repo/.worktrees/wf/a" },
        { id: "/repo/.worktrees/wf/b", name: "wf/b", path: "/repo/.worktrees/wf/b" },
      ],
      machines: [],
      sessions: [
        session({ id: "sib-a", workspaceId: "/repo/.worktrees/wf/a" }),
        session({ id: "sib-b", workspaceId: "/repo/.worktrees/wf/b" }),
      ],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspace.id).toBe("/repo");
    expect(groups[0]?.sessions.map((s) => s.id).sort()).toEqual(["sib-a", "sib-b"]);
  });

  it("omits a workspace that has no sessions", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "w1", name: "has-sessions", path: "w1" },
        { id: "w2", name: "empty", path: "w2" },
      ],
      machines: [],
      sessions: [session({ id: "a", workspaceId: "w1" })],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups.map((g) => g.workspace.id)).toEqual(["w1"]);
  });
});

describe("groupPagedSessions", () => {
  const workspaces: SessionListWorkspace[] = [
    { id: "a", name: "workspace-a", path: "a" },
    { id: "b", name: "workspace-b", path: "b" },
  ];

  it("preserves first-appearance order rather than re-deriving group recency", () => {
    // "b" appears first in the already-recency-ordered input even though
    // "a" has a session with a higher updatedAt further down the list — a
    // paged slice must not silently re-sort back to whole-group recency.
    const sessions = [
      session({ id: "b1", workspaceId: "b", updatedAt: 90 }),
      session({ id: "a1", workspaceId: "a", updatedAt: 100 }),
      session({ id: "a2", workspaceId: "a", updatedAt: 80 }),
    ];
    const groups = groupPagedSessions(sessions, workspaces);
    expect(groups.map((g) => g.workspace.id)).toEqual(["b", "a"]);
  });

  it("sorts sessions within each group pinned-first then newest-first", () => {
    const sessions = [
      session({ id: "a-unpinned-new", workspaceId: "a", updatedAt: 100, pinned: false }),
      session({ id: "a-pinned-old", workspaceId: "a", updatedAt: 1, pinned: true }),
    ];
    const groups = groupPagedSessions(sessions, workspaces);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["a-pinned-old", "a-unpinned-new"]);
  });

  it("buckets unresolvable workspaces into a trailing 'Other sessions' group", () => {
    const sessions = [
      session({ id: "placed", workspaceId: "a", updatedAt: 10 }),
      session({ id: "orphan", workspaceId: null, updatedAt: 5 }),
    ];
    const groups = groupPagedSessions(sessions, workspaces);
    expect(groups.map((g) => g.workspace.id)).toEqual(["a", UNGROUPED_WORKSPACE_ID]);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupPagedSessions([], workspaces)).toEqual([]);
  });

  it("re-parents a worktree child onto its registered parent repo", () => {
    const withWorktree: SessionListWorkspace[] = [
      ...workspaces,
      { id: "a/.worktrees/wf/x", name: "wf/x", path: "a/.worktrees/wf/x" },
    ];
    const sessions = [
      session({ id: "child", workspaceId: "a/.worktrees/wf/x", updatedAt: 10 }),
      session({ id: "main", workspaceId: "a", updatedAt: 5 }),
    ];
    const groups = groupPagedSessions(sessions, withWorktree);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspace.id).toBe("a");
    expect(groups[0]?.sessions.map((s) => s.id).sort()).toEqual(["child", "main"]);
  });

  it("leaves a worktree child top-level when its parent isn't registered", () => {
    const worktreeWorkspaces: SessionListWorkspace[] = [
      { id: "unregistered/.worktrees/wf/x", name: "wf/x", path: "unregistered/.worktrees/wf/x" },
    ];
    const sessions = [session({ id: "orphan", workspaceId: "unregistered/.worktrees/wf/x" })];
    const groups = groupPagedSessions(sessions, worktreeWorkspaces);
    expect(groups.map((g) => g.workspace.id)).toEqual(["unregistered/.worktrees/wf/x"]);
  });

  it("groups two sibling worktrees under the same registered parent", () => {
    const withWorktrees: SessionListWorkspace[] = [
      ...workspaces,
      { id: "a/.worktrees/wf/a", name: "wf/a", path: "a/.worktrees/wf/a" },
      { id: "a/.worktrees/wf/b", name: "wf/b", path: "a/.worktrees/wf/b" },
    ];
    const sessions = [
      session({ id: "sib-a", workspaceId: "a/.worktrees/wf/a" }),
      session({ id: "sib-b", workspaceId: "a/.worktrees/wf/b" }),
    ];
    const groups = groupPagedSessions(sessions, withWorktrees);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspace.id).toBe("a");
  });
});
