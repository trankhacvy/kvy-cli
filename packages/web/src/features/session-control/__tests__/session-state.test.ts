import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import {
  deriveControlMode,
  deriveCurrentPermissionMode,
  deriveWorking,
  isTurnOpen,
} from "../session-state.js";

describe("deriveControlMode", () => {
  it("defaults to 'local' when there's no mode-switch item", () => {
    expect(deriveControlMode([])).toBe("local");
  });

  it("reflects the most recent mode-switch item", () => {
    const items: RenderItem[] = [
      { id: "m1", time: 1, role: "agent", kind: "mode-switch", control: "remote", by: "client" },
      { id: "m2", time: 2, role: "agent", kind: "mode-switch", control: "local", by: "terminal" },
    ];
    expect(deriveControlMode(items)).toBe("local");
  });
});

describe("deriveCurrentPermissionMode", () => {
  it("defaults to 'default' when there's no mode decision yet", () => {
    expect(deriveCurrentPermissionMode([])).toBe("default");
  });

  it("reflects a 'mode' perm-resolve decision applied onto a tool item", () => {
    const items: RenderItem[] = [
      {
        id: "t1",
        time: 1,
        role: "agent",
        kind: "tool",
        call: "c1",
        name: "ExitPlanMode",
        args: { plan: "do the thing" },
        status: "done",
        permission: {
          reqId: "r1",
          modes: ["default", "acceptEdits", "bypassPermissions"],
          decision: { kind: "mode", mode: "acceptEdits" },
        },
      },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("acceptEdits");
  });

  it("reflects a 'mode' decision applied onto a still-unmatched perm-placeholder", () => {
    const items: RenderItem[] = [
      {
        id: "p1",
        time: 1,
        role: "agent",
        kind: "perm-placeholder",
        name: "ExitPlanMode",
        args: { plan: "do the thing" },
        permission: {
          reqId: "r1",
          modes: ["default", "acceptEdits", "bypassPermissions"],
          decision: { kind: "mode", mode: "bypassPermissions" },
        },
      },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("bypassPermissions");
  });

  it("takes the most recent 'mode' decision when more than one has landed", () => {
    const items: RenderItem[] = [
      {
        id: "t1",
        time: 1,
        role: "agent",
        kind: "tool",
        call: "c1",
        name: "ExitPlanMode",
        args: {},
        status: "done",
        permission: {
          reqId: "r1",
          modes: ["default", "acceptEdits", "bypassPermissions"],
          decision: { kind: "mode", mode: "acceptEdits" },
        },
      },
      {
        id: "t2",
        time: 2,
        role: "agent",
        kind: "tool",
        call: "c2",
        name: "ExitPlanMode",
        args: {},
        status: "done",
        permission: {
          reqId: "r2",
          modes: ["default", "acceptEdits", "bypassPermissions"],
          decision: { kind: "mode", mode: "bypassPermissions" },
        },
      },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("bypassPermissions");
  });

  it("ignores non-'mode' decisions (allow/deny don't carry a mode)", () => {
    const items: RenderItem[] = [
      {
        id: "t1",
        time: 1,
        role: "agent",
        kind: "tool",
        call: "c1",
        name: "Bash",
        args: {},
        status: "done",
        permission: {
          reqId: "r1",
          modes: ["default", "acceptEdits", "plan", "bypassPermissions"],
          decision: { kind: "allow", scope: "once" },
        },
      },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("default");
  });

  it("reflects a 'permission-mode' item with source:'terminal', independent of any pending decision", () => {
    const items: RenderItem[] = [
      {
        id: "pm1",
        time: 1,
        role: "agent",
        kind: "permission-mode",
        mode: "acceptEdits",
        source: "terminal",
      },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("acceptEdits");
  });

  it("takes the most recent of a 'permission-mode' item and a later mode decision, in stream order", () => {
    const items: RenderItem[] = [
      {
        id: "pm1",
        time: 1,
        role: "agent",
        kind: "permission-mode",
        mode: "acceptEdits",
        source: "terminal",
      },
      {
        id: "t1",
        time: 2,
        role: "agent",
        kind: "tool",
        call: "c1",
        name: "ExitPlanMode",
        args: {},
        status: "done",
        permission: {
          reqId: "r1",
          modes: ["default", "acceptEdits", "bypassPermissions"],
          decision: { kind: "mode", mode: "bypassPermissions" },
        },
      },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("bypassPermissions");
  });

  it("resets to 'default' on a mode-switch, even after a known mode decision", () => {
    const items: RenderItem[] = [
      {
        id: "t1",
        time: 1,
        role: "agent",
        kind: "tool",
        call: "c1",
        name: "ExitPlanMode",
        args: {},
        status: "done",
        permission: {
          reqId: "r1",
          modes: ["default", "acceptEdits", "bypassPermissions"],
          decision: { kind: "mode", mode: "bypassPermissions" },
        },
      },
      { id: "m1", time: 2, role: "agent", kind: "mode-switch", control: "remote", by: "client" },
    ];
    expect(deriveCurrentPermissionMode(items)).toBe("default");
  });
});

describe("isTurnOpen", () => {
  it("is false with no turn items", () => {
    expect(isTurnOpen([])).toBe(false);
  });

  it("is true after a turn-start with no matching turn-end", () => {
    const items: RenderItem[] = [{ id: "t1", time: 1, role: "agent", kind: "turn-start" }];
    expect(isTurnOpen(items)).toBe(true);
  });

  it("is false once a turn-end closes the turn", () => {
    const items: RenderItem[] = [
      { id: "t1", time: 1, role: "agent", kind: "turn-start" },
      { id: "t2", time: 2, role: "agent", kind: "turn-end", status: "completed" },
    ];
    expect(isTurnOpen(items)).toBe(false);
  });

  it("re-opens on a second turn-start after a closed first turn", () => {
    const items: RenderItem[] = [
      { id: "t1", time: 1, role: "agent", kind: "turn-start" },
      { id: "t2", time: 2, role: "agent", kind: "turn-end", status: "completed" },
      { id: "t3", time: 3, role: "user", kind: "turn-start" },
    ];
    expect(isTurnOpen(items)).toBe(true);
  });
});

describe("deriveWorking (the stuck 'Working…' header)", () => {
  it("is true while the turn is open, regardless of the ephemeral hint", () => {
    const items: RenderItem[] = [{ id: "t1", time: 1, role: "agent", kind: "turn-start" }];
    expect(deriveWorking(items, false)).toBe(true);
    expect(deriveWorking(items, true)).toBe(true);
  });

  it("trusts a `true` ephemeral hint before any turn history has landed yet", () => {
    expect(deriveWorking([], true)).toBe(true);
  });

  it("is false with no turn history and no ephemeral hint", () => {
    expect(deriveWorking([], false)).toBe(false);
  });

  it("never lets a stuck-true ephemeral override a turn that has already closed (the reported bug)", () => {
    const items: RenderItem[] = [
      { id: "t1", time: 1, role: "agent", kind: "turn-start" },
      { id: "t2", time: 2, role: "agent", kind: "turn-end", status: "completed" },
    ];
    // Simulates the ephemeral's `working:false` companion having been
    // dropped (or a stray `working:true` re-arriving) — `isTurnOpen(items)`
    // already correctly says the turn is closed, and that must win.
    expect(deriveWorking(items, true)).toBe(false);
  });

  it("stays false for a stuck-true ephemeral even after a failed/cancelled turn-end", () => {
    const items: RenderItem[] = [
      { id: "t1", time: 1, role: "agent", kind: "turn-start" },
      { id: "t2", time: 2, role: "agent", kind: "turn-end", status: "failed" },
    ];
    expect(deriveWorking(items, true)).toBe(false);
  });

  it("re-opens correctly on a genuine second turn, independent of the ephemeral hint", () => {
    const items: RenderItem[] = [
      { id: "t1", time: 1, role: "agent", kind: "turn-start" },
      { id: "t2", time: 2, role: "agent", kind: "turn-end", status: "completed" },
      { id: "t3", time: 3, role: "user", kind: "turn-start" },
    ];
    expect(deriveWorking(items, false)).toBe(true);
  });
});
