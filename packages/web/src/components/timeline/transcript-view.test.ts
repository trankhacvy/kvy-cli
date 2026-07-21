import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import {
  getVisibleTranscriptItems,
  hasVisibleTranscriptItems,
  shouldShowTranscriptWorking,
} from "./transcript-view";

function userText(id: string, time: number): RenderItem {
  return { id, time, role: "user", kind: "text", md: "hi", thinking: false };
}

function permissionMode(id: string, time: number): RenderItem {
  return {
    id,
    time,
    role: "agent",
    kind: "permission-mode",
    mode: "acceptEdits",
    source: "terminal",
  };
}

describe("getVisibleTranscriptItems — permission-mode (docs/bug-fix-plan.md #5)", () => {
  it("hides a permission-mode item, same as mode-switch, while keeping a sibling visible item", () => {
    const items: RenderItem[] = [userText("u1", 1), permissionMode("pm1", 2)];
    const visible = getVisibleTranscriptItems(items);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.kind).toBe("text");
  });
});

describe("hasVisibleTranscriptItems — permission-mode", () => {
  it("is false when the only items are a permission-mode marker", () => {
    expect(hasVisibleTranscriptItems([permissionMode("pm1", 1)])).toBe(false);
  });
});

describe("shouldShowTranscriptWorking — a mid-turn permission-mode event doesn't clear 'Working…' (docs/bug-fix-plan.md #5 drift fix)", () => {
  it("stays true when a Shift+Tab happens after the latest user message and before any agent reply", () => {
    const items: RenderItem[] = [userText("u1", 1), permissionMode("pm1", 2)];
    expect(shouldShowTranscriptWorking(true, items)).toBe(true);
  });

  it("still clears once a real visible agent reply follows the permission-mode event", () => {
    const items: RenderItem[] = [
      userText("u1", 1),
      permissionMode("pm1", 2),
      { id: "a1", time: 3, role: "agent", kind: "text", md: "done", thinking: false },
    ];
    expect(shouldShowTranscriptWorking(true, items)).toBe(false);
  });

  it("is false outright when the caller says working is false, regardless of items", () => {
    expect(shouldShowTranscriptWorking(false, [userText("u1", 1), permissionMode("pm1", 2)])).toBe(
      false,
    );
  });
});
