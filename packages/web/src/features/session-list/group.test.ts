import { describe, expect, it } from "vitest";
import { groupSessionsByWorkspace, UNGROUPED_WORKSPACE_ID } from "./group";
import type { SessionListSession, SessionListSnapshot } from "./types";

function session(overrides: Partial<SessionListSession>): SessionListSession {
  return {
    id: "s1",
    workspaceId: "w1",
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
      workspaces: [{ id: "w1", name: "falcon" }],
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
        { id: "stale", name: "stale-repo" },
        { id: "fresh", name: "fresh-repo" },
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
      workspaces: [{ id: "w1", name: "falcon" }],
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
      workspaces: [{ id: "w1", name: "falcon" }],
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
        { id: "a", name: "workspace-a" },
        { id: "b", name: "workspace-b" },
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

  it("omits a workspace that has no sessions", () => {
    const snapshot: SessionListSnapshot = {
      workspaces: [
        { id: "w1", name: "has-sessions" },
        { id: "w2", name: "empty" },
      ],
      machines: [],
      sessions: [session({ id: "a", workspaceId: "w1" })],
    };
    const groups = groupSessionsByWorkspace(snapshot);
    expect(groups.map((g) => g.workspace.id)).toEqual(["w1"]);
  });
});
