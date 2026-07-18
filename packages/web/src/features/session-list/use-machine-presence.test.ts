import type { MachineRow } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { deriveMachineOnline, MACHINE_ONLINE_WINDOW_MS } from "./use-machine-presence";

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

describe("deriveMachineOnline", () => {
  const now = 1_000_000;

  it("falls back to the lastSeenAt heuristic when no live presence has arrived", () => {
    const machine = makeMachine({ lastSeenAt: now - 1000 });
    expect(deriveMachineOnline(machine, new Map(), now)).toBe(true);
  });

  it("is offline via the heuristic once lastSeenAt is past the window", () => {
    const machine = makeMachine({ lastSeenAt: now - MACHINE_ONLINE_WINDOW_MS - 1 });
    expect(deriveMachineOnline(machine, new Map(), now)).toBe(false);
  });

  it("is offline when lastSeenAt has never been reported", () => {
    const machine = makeMachine({ lastSeenAt: null });
    expect(deriveMachineOnline(machine, new Map(), now)).toBe(false);
  });

  it("a live presence:false wins over a fresh lastSeenAt heuristic", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now - 1000 });
    const presence = new Map([["mach-1", false]]);
    expect(deriveMachineOnline(machine, presence, now)).toBe(false);
  });

  it("a live presence:true wins over a stale lastSeenAt heuristic", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now - MACHINE_ONLINE_WINDOW_MS - 1 });
    const presence = new Map([["mach-1", true]]);
    expect(deriveMachineOnline(machine, presence, now)).toBe(true);
  });

  it("only consults presence for the matching machineId", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: null });
    const presence = new Map([["mach-other", true]]);
    expect(deriveMachineOnline(machine, presence, now)).toBe(false);
  });
});
