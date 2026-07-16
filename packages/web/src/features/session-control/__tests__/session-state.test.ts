import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import { deriveControlMode, isTurnOpen } from "../session-state.js";

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
