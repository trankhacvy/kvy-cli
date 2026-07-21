import { createEnvelope, type MachineRow, type SessionRow } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { reduceEnvelopes } from "@/sync/reducer";
import type { MessagesQueryData } from "@/sync/types";
import { buildSnapshot, newestSeq } from "./live-source";
import { deriveSessionStatus } from "./status";
import type { AttentionKind } from "./types";

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    accountId: "acc-1",
    workspaceId: "ws-1",
    machineId: "mach-1",
    tag: "sess-1-tag",
    provider: "claude",
    executionTarget: "pty",
    status: "active",
    metadata: { value: { t: "enc", v: 1, c: "meta" }, version: 1 },
    agentState: null,
    dek: "dek-opaque",
    msgSeq: 0,
    notificationsMuted: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeMachine(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: "mach-1",
    accountId: "acc-1",
    metadata: { value: { t: "enc", v: 1, c: "meta" }, version: 1 },
    daemonState: null,
    dek: "dek-opaque",
    lastSeenAt: null,
    ...overrides,
  };
}

const EMPTY_TITLES = { sessions: new Map<string, string>(), machines: new Map<string, string>() };

describe("newestSeq", () => {
  it("is undefined when the page hasn't fetched yet", () => {
    expect(newestSeq(undefined)).toBeUndefined();
  });

  it("is 0 for a fetched-but-empty page", () => {
    expect(
      newestSeq({ pages: [{ messages: [], nextBefore: null }], pageParams: [undefined] }),
    ).toBe(0);
  });

  it("is the newest message's seq for a fetched page", () => {
    const data: MessagesQueryData = {
      pages: [
        {
          messages: [
            { seq: 5, localId: null, content: { t: "enc", v: 1, c: "x" }, createdAt: 1 },
            { seq: 4, localId: null, content: { t: "enc", v: 1, c: "y" }, createdAt: 0 },
          ],
          nextBefore: null,
        },
      ],
      pageParams: [undefined],
    };
    expect(newestSeq(data)).toBe(5);
  });
});

describe("buildSnapshot (status-derivation fixtures)", () => {
  it("prefers live machine-presence over a fresh lastSeenAt heuristic", () => {
    const now = Date.now();
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now });
    const session = makeSession({ id: "sess-1", machineId: "mach-1" });
    const presence = new Map([["mach-1", false]]); // live signal says offline despite a fresh heartbeat

    const snapshot = buildSnapshot(
      [session],
      [machine],
      EMPTY_TITLES,
      presence,
      new Map(),
      new Map(),
    );

    expect(snapshot.machines[0]?.online).toBe(false);
  });

  it("feeds a decrypted open-turn message page through to a 'working' status dot", () => {
    const session = makeSession({ id: "sess-1", machineId: "mach-1" });
    const machine = makeMachine({ id: "mach-1", lastSeenAt: Date.now() });
    const items = reduceEnvelopes([createEnvelope("user", { t: "turn-start" }, { time: 1 })]);

    const snapshot = buildSnapshot(
      [session],
      [machine],
      EMPTY_TITLES,
      new Map(),
      new Map([["sess-1", items]]),
      new Map(),
    );

    const built = snapshot.sessions[0];
    expect(built).toBeDefined();
    const status = deriveSessionStatus({
      status: built?.status ?? "active",
      machineOnline: snapshot.machines[0]?.online ?? null,
      items: built?.items ?? [],
      attention: built?.attention ?? null,
    });
    expect(status).toBe("working");
  });

  it("degrades honestly to idle (never a fabricated 'working') before this session's page has decrypted", () => {
    const session = makeSession({ id: "sess-1", machineId: "mach-1" });
    const machine = makeMachine({ id: "mach-1", lastSeenAt: Date.now() });

    // No entry in the items map yet — this session's message page hasn't
    // decrypted (or hasn't been fetched) this pass.
    const snapshot = buildSnapshot(
      [session],
      [machine],
      EMPTY_TITLES,
      new Map(),
      new Map(),
      new Map(),
    );

    expect(snapshot.sessions[0]?.items).toEqual([]);
    const status = deriveSessionStatus({
      status: "active",
      machineOnline: true,
      items: snapshot.sessions[0]?.items ?? [],
      attention: snapshot.sessions[0]?.attention ?? null,
    });
    expect(status).toBe("idle");
  });

  it("feeds a live attention:question ephemeral through to waiting-for-input", () => {
    const session = makeSession({ id: "sess-1", machineId: null });
    const attention = new Map<string, AttentionKind>([["sess-1", "question"]]);

    const snapshot = buildSnapshot([session], [], EMPTY_TITLES, new Map(), new Map(), attention);

    expect(snapshot.sessions[0]?.attention).toBe("question");
    const status = deriveSessionStatus({
      status: "active",
      machineOnline: null,
      items: [],
      attention: snapshot.sessions[0]?.attention ?? null,
    });
    expect(status).toBe("waiting-for-input");
  });

  it("carries null (not a placeholder string) for rows that haven't decrypted yet (Issue #13)", () => {
    const session = makeSession({ id: "sess-1" });
    const machine = makeMachine({ id: "mach-1" });

    const snapshot = buildSnapshot(
      [session],
      [machine],
      EMPTY_TITLES,
      new Map(),
      new Map(),
      new Map(),
    );

    expect(snapshot.sessions[0]?.title).toBeNull();
    expect(snapshot.machines[0]?.name).toBeNull();
  });

  it("surfaces the honest placeholder title/name once decryption has genuinely resolved to none", () => {
    const session = makeSession({ id: "sess-1" });
    const machine = makeMachine({ id: "mach-1" });
    const titles = {
      sessions: new Map([["sess-1", "(untitled session)"]]),
      machines: new Map([["mach-1", "(unnamed machine)"]]),
    };

    const snapshot = buildSnapshot([session], [machine], titles, new Map(), new Map(), new Map());

    expect(snapshot.sessions[0]?.title).toBe("(untitled session)");
    expect(snapshot.machines[0]?.name).toBe("(unnamed machine)");
  });

  it("derives a workspace's display name from the basename of its id/path", () => {
    const session = makeSession({ id: "sess-1", workspaceId: "/Users/vy/projects/falcon" });

    const snapshot = buildSnapshot([session], [], EMPTY_TITLES, new Map(), new Map(), new Map());

    expect(snapshot.workspaces).toEqual([{ id: "/Users/vy/projects/falcon", name: "falcon" }]);
  });

  it("dedupes multiple sessions sharing the same workspaceId into one workspace entry", () => {
    const a = makeSession({ id: "sess-1", workspaceId: "/ws/one" });
    const b = makeSession({ id: "sess-2", workspaceId: "/ws/one" });

    const snapshot = buildSnapshot([a, b], [], EMPTY_TITLES, new Map(), new Map(), new Map());

    expect(snapshot.workspaces).toEqual([{ id: "/ws/one", name: "one" }]);
  });

  it("excludes sessions with no workspaceId from the workspaces list", () => {
    const session = makeSession({ id: "sess-1", workspaceId: null });

    const snapshot = buildSnapshot([session], [], EMPTY_TITLES, new Map(), new Map(), new Map());

    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.sessions[0]?.workspaceId).toBeNull();
  });

  it("falls back to the full id for a workspace path with no usable basename", () => {
    const session = makeSession({ id: "sess-1", workspaceId: "/" });

    const snapshot = buildSnapshot([session], [], EMPTY_TITLES, new Map(), new Map(), new Map());

    expect(snapshot.workspaces).toEqual([{ id: "/", name: "/" }]);
  });

  it("strips a trailing slash before deriving the basename", () => {
    const session = makeSession({ id: "sess-1", workspaceId: "/Users/vy/projects/falcon/" });

    const snapshot = buildSnapshot([session], [], EMPTY_TITLES, new Map(), new Map(), new Map());

    expect(snapshot.workspaces).toEqual([{ id: "/Users/vy/projects/falcon/", name: "falcon" }]);
  });
});
