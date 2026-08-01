import type { MachineRow, UnmanagedSessionRow } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import { buildSnapshot } from "./live-source";

function makeRow(overrides: Partial<UnmanagedSessionRow> = {}): UnmanagedSessionRow {
  return {
    id: "u-1",
    accountId: "acc-1",
    machineId: "mach-1",
    workspaceId: "ws-1",
    providerRef: "prov-1",
    summary: { t: "enc", v: 1, c: "summary" },
    dek: "dek-opaque",
    updatedAt: 1000,
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

const EMPTY_DECRYPTED = { summaries: new Map(), machineNames: new Map() };

describe("buildSnapshot (unmanaged sessions)", () => {
  it("falls back to an honest placeholder title/running:false before a row's summary has decrypted", () => {
    const row = makeRow({ id: "u-1", updatedAt: 500 });

    const snapshot = buildSnapshot([row], [], EMPTY_DECRYPTED, new Map());

    expect(snapshot.sessions).toEqual([
      {
        id: "u-1",
        machineId: "mach-1",
        workspaceId: "ws-1",
        providerRef: "prov-1",
        title: "(untitled session)",
        lastActivityAt: 500, // falls back to the row's updatedAt
        running: false,
        updatedAt: 500,
      },
    ]);
  });

  it("uses the decrypted summary once available", () => {
    const row = makeRow({ id: "u-1" });
    const decrypted = {
      summaries: new Map([
        ["u-1", { title: "Fix the flaky test", lastActivity: 2000, running: true }],
      ]),
      machineNames: new Map([["mach-1", "vy-macbook-pro"]]),
    };
    const machine = makeMachine({ id: "mach-1" });

    const snapshot = buildSnapshot([row], [machine], decrypted, new Map());

    expect(snapshot.sessions[0]).toMatchObject({
      title: "Fix the flaky test",
      lastActivityAt: 2000,
      running: true,
    });
    expect(snapshot.machines[0]).toMatchObject({ id: "mach-1", name: "vy-macbook-pro" });
  });

  it("only includes machines actually referenced by an unmanaged row", () => {
    const row = makeRow({ machineId: "mach-1" });
    const referenced = makeMachine({ id: "mach-1" });
    const unreferenced = makeMachine({ id: "mach-2" });

    const snapshot = buildSnapshot([row], [referenced, unreferenced], EMPTY_DECRYPTED, new Map());

    expect(snapshot.machines.map((m) => m.id)).toEqual(["mach-1"]);
  });

  it("prefers live machine-presence over a fresh lastSeenAt heuristic", () => {
    const now = Date.now();
    const row = makeRow({ machineId: "mach-1" });
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now });
    const presence = new Map([["mach-1", { online: false }]]);

    const snapshot = buildSnapshot([row], [machine], EMPTY_DECRYPTED, presence);

    expect(snapshot.machines[0]?.online).toBe(false);
  });
});
