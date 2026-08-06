import { describe, expect, it } from "vitest";
import type { WorkspaceGroup } from "./group";
import {
  deriveDefaultTargetMachineId,
  deriveWorkspaceTargetMachines,
  workspaceNeedsMachineChoice,
} from "./target-machine";
import type { SessionListSession } from "./types";

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

function group(sessions: SessionListSession[]): WorkspaceGroup {
  return { workspace: { id: "w1", name: "kvy", path: null }, sessions };
}

describe("deriveWorkspaceTargetMachines", () => {
  it("returns a single machine, most-recently-active timestamp, for a single-machine group", () => {
    const machines = deriveWorkspaceTargetMachines(
      group([
        session({ id: "a", machineId: "m1", updatedAt: 10 }),
        session({ id: "b", machineId: "m1", updatedAt: 50 }),
      ]),
    );
    expect(machines).toEqual([{ machineId: "m1", lastActiveAt: 50 }]);
  });

  it("returns every distinct machine, most-recently-active first", () => {
    const machines = deriveWorkspaceTargetMachines(
      group([
        session({ id: "a", machineId: "m-old", updatedAt: 1 }),
        session({ id: "b", machineId: "m-new", updatedAt: 100 }),
        session({ id: "c", machineId: "m-mid", updatedAt: 50 }),
      ]),
    );
    expect(machines).toEqual([
      { machineId: "m-new", lastActiveAt: 100 },
      { machineId: "m-mid", lastActiveAt: 50 },
      { machineId: "m-old", lastActiveAt: 1 },
    ]);
  });

  it("uses each machine's OWN most recent session, not the group's overall most recent", () => {
    // m1's most recent session (50) is older than m2's freshest (100), but
    // m1 also has an even-older session (5) that must not win out over its
    // own 50.
    const machines = deriveWorkspaceTargetMachines(
      group([
        session({ id: "a", machineId: "m1", updatedAt: 5 }),
        session({ id: "b", machineId: "m1", updatedAt: 50 }),
        session({ id: "c", machineId: "m2", updatedAt: 100 }),
      ]),
    );
    expect(machines).toEqual([
      { machineId: "m2", lastActiveAt: 100 },
      { machineId: "m1", lastActiveAt: 50 },
    ]);
  });

  it("excludes sessions with a null machineId", () => {
    const machines = deriveWorkspaceTargetMachines(
      group([session({ id: "a", machineId: null, updatedAt: 10 })]),
    );
    expect(machines).toEqual([]);
  });

  it("returns an empty array for a workspace group with no sessions", () => {
    expect(deriveWorkspaceTargetMachines(group([]))).toEqual([]);
  });
});

describe("workspaceNeedsMachineChoice", () => {
  it("is false for a single-machine group", () => {
    expect(workspaceNeedsMachineChoice(group([session({ machineId: "m1" })]))).toBe(false);
  });

  it("is true once a group spans more than one distinct machine", () => {
    expect(
      workspaceNeedsMachineChoice(
        group([session({ id: "a", machineId: "m1" }), session({ id: "b", machineId: "m2" })]),
      ),
    ).toBe(true);
  });

  it("is false for a group with no resolvable machine at all", () => {
    expect(workspaceNeedsMachineChoice(group([session({ machineId: null })]))).toBe(false);
  });
});

describe("deriveDefaultTargetMachineId", () => {
  it("defaults to the most-recently-active machine", () => {
    const id = deriveDefaultTargetMachineId(
      group([
        session({ id: "a", machineId: "m-old", updatedAt: 1 }),
        session({ id: "b", machineId: "m-new", updatedAt: 100 }),
      ]),
    );
    expect(id).toBe("m-new");
  });

  it("returns null when the group has no session with a resolvable machineId", () => {
    expect(deriveDefaultTargetMachineId(group([session({ machineId: null })]))).toBeNull();
  });

  it("returns null for an empty group", () => {
    expect(deriveDefaultTargetMachineId(group([]))).toBeNull();
  });
});
