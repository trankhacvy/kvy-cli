import { describe, expect, it } from "vitest";
import type { RenderItem, ToolItem } from "@/sync/reducer";
import { isNearBottom, shouldShowActivityRow } from "./Timeline";

function textItem(id: string): RenderItem {
  return { id, time: 0, role: "agent", kind: "text", md: "hi", thinking: false };
}

function toolItem(id: string, status: ToolItem["status"]): ToolItem {
  return {
    id,
    time: 0,
    role: "agent",
    kind: "tool",
    call: id,
    name: "Bash",
    args: {},
    status,
  };
}

describe("isNearBottom (W1.6 follow/pause threshold)", () => {
  it("stays following when scrolled all the way to the bottom", () => {
    expect(isNearBottom(0, 600)).toBe(true);
  });

  it("stays following within half a viewport of the bottom", () => {
    expect(isNearBottom(299, 600)).toBe(true);
  });

  it("pauses following once scrolled more than half a viewport away", () => {
    expect(isNearBottom(301, 600)).toBe(false);
  });

  it("resumes once back within the band", () => {
    // Simulates scroll-up-then-back-down: same predicate, different distance.
    expect(isNearBottom(400, 600)).toBe(false);
    expect(isNearBottom(100, 600)).toBe(true);
  });

  it("treats exactly half a viewport as past the band (strict less-than)", () => {
    expect(isNearBottom(300, 600)).toBe(false);
  });

  it("never counts as near-bottom on a zero-height viewport (strict less-than, not <=)", () => {
    expect(isNearBottom(0, 0)).toBe(false);
  });
});

describe("shouldShowActivityRow (W1.8 pulse row)", () => {
  it("is hidden when not working", () => {
    expect(shouldShowActivityRow(false, [textItem("1")])).toBe(false);
  });

  it("is hidden on an empty timeline even while working", () => {
    expect(shouldShowActivityRow(true, [])).toBe(false);
  });

  it("shows while working and the last item is a finished message", () => {
    expect(shouldShowActivityRow(true, [textItem("1")])).toBe(true);
  });

  it("shows while working and the last item is a completed tool", () => {
    expect(shouldShowActivityRow(true, [toolItem("t1", "done")])).toBe(true);
  });

  it("is suppressed when the last item is already a running tool card", () => {
    expect(shouldShowActivityRow(true, [textItem("1"), toolItem("t1", "running")])).toBe(false);
  });

  it("shows when a running tool exists but is not the last item", () => {
    // Only the last item gates suppression — an earlier running tool (e.g. a
    // completed subagent step) shouldn't hide the row.
    expect(shouldShowActivityRow(true, [toolItem("t1", "running"), textItem("1")])).toBe(true);
  });

  it("is suppressed by a running tool even with other items before it", () => {
    expect(
      shouldShowActivityRow(true, [
        textItem("1"),
        toolItem("t1", "done"),
        toolItem("t2", "running"),
      ]),
    ).toBe(false);
  });
});
