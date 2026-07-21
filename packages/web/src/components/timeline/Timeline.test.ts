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

function userTextItem(id: string): RenderItem {
  return { id, time: 0, role: "user", kind: "text", md: "yo", thinking: false };
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

  it("shows while working after the latest user message and before any agent reply lands", () => {
    expect(shouldShowActivityRow(true, [userTextItem("u1")])).toBe(true);
  });

  it("is hidden once an agent reply has landed after the latest user message", () => {
    expect(shouldShowActivityRow(true, [userTextItem("u1"), textItem("1")])).toBe(false);
  });

  it("is hidden once a running tool card has landed after the latest user message", () => {
    expect(shouldShowActivityRow(true, [userTextItem("u1"), toolItem("t1", "running")])).toBe(
      false,
    );
  });

  it("is hidden when only hidden metadata rows remain", () => {
    expect(
      shouldShowActivityRow(true, [
        { id: "s1", time: 0, role: "agent", kind: "service", text: "Session started", quiet: true },
      ]),
    ).toBe(false);
  });

  it("is hidden when the only visible follow-up is empty reasoning", () => {
    expect(
      shouldShowActivityRow(true, [
        userTextItem("u1"),
        { id: "a1", time: 0, role: "agent", kind: "text", md: "   ", thinking: true },
      ]),
    ).toBe(true);
  });
});
