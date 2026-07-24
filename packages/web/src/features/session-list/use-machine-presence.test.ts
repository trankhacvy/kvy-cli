import type { MachineRow } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import {
  deriveMachineOnline,
  deriveMachineStatus,
  MACHINE_ONLINE_WINDOW_MS,
  type MachinePresence,
} from "./use-machine-presence";

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

function presenceOf(machineId: string, value: MachinePresence): Map<string, MachinePresence> {
  return new Map([[machineId, value]]);
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
    const presence = presenceOf("mach-1", { online: false });
    expect(deriveMachineOnline(machine, presence, now)).toBe(false);
  });

  it("a live presence:true wins over a stale lastSeenAt heuristic", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now - MACHINE_ONLINE_WINDOW_MS - 1 });
    const presence = presenceOf("mach-1", { online: true });
    expect(deriveMachineOnline(machine, presence, now)).toBe(true);
  });

  it("only consults presence for the matching machineId", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: null });
    const presence = presenceOf("mach-other", { online: true });
    expect(deriveMachineOnline(machine, presence, now)).toBe(false);
  });
});

// AH8 "machine-status-reauth" (docs/auth-ux-hardening-plan.md item 8): a distinct status
// from plain "offline" — this suite is the exact scenario pair sub-task 4 calls for.
describe("deriveMachineStatus", () => {
  const now = 1_000_000;

  it("is online for a fresh heartbeat with no live event yet", () => {
    const machine = makeMachine({ lastSeenAt: now - 1000 });
    expect(deriveMachineStatus(machine, new Map(), now)).toBe("online");
  });

  it("is offline (not needs-reauth) for a merely-asleep machine — stale lastSeenAt, no needsReauth flag", () => {
    const machine = makeMachine({ lastSeenAt: now - MACHINE_ONLINE_WINDOW_MS - 1 });
    expect(deriveMachineStatus(machine, new Map(), now)).toBe("offline");
  });

  it("is offline (not needs-reauth) on a live presence:false event with no needsReauth flag", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now });
    const presence = presenceOf("mach-1", { online: false });
    expect(deriveMachineStatus(machine, presence, now)).toBe("offline");
  });

  it("is needs-reauth on a live presence event carrying needsReauth:true, even though online:false looks like plain offline", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now });
    const presence = presenceOf("mach-1", { online: false, needsReauth: true });
    expect(deriveMachineStatus(machine, presence, now)).toBe("needs-reauth");
  });

  it("is needs-reauth from the bootstrap MachineRow.needsReauth field before any live event has arrived", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now, needsReauth: true });
    expect(deriveMachineStatus(machine, new Map(), now)).toBe("needs-reauth");
  });

  it("a live event always wins over the bootstrap needsReauth field, even if the live event says online", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now, needsReauth: true });
    const presence = presenceOf("mach-1", { online: true });
    expect(deriveMachineStatus(machine, presence, now)).toBe("online");
  });

  it("is online for a live presence:true event, regardless of a stale lastSeenAt", () => {
    const machine = makeMachine({ id: "mach-1", lastSeenAt: now - MACHINE_ONLINE_WINDOW_MS - 1 });
    const presence = presenceOf("mach-1", { online: true });
    expect(deriveMachineStatus(machine, presence, now)).toBe("online");
  });
});
