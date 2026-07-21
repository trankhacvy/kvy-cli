import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import { groupRenderItems } from "./RenderItemGroups";
import { getVisibleTranscriptItems } from "./transcript-view";

function agentText(id: string, md: string, turn?: string, thinking = false): RenderItem {
  return { id, time: Number(id.replace(/\D/g, "")) || 0, role: "agent", kind: "text", md, turn, thinking };
}

function userText(id: string, md: string, turn?: string): RenderItem {
  return { id, time: Number(id.replace(/\D/g, "")) || 0, role: "user", kind: "text", md, turn, thinking: false };
}

describe("groupRenderItems", () => {
  it("groups adjacent assistant text, thinking, and tool activity into one message block", () => {
    const items: RenderItem[] = [
      agentText("a1", "thinking", "t1", true),
      {
        id: "a2",
        time: 2,
        role: "agent",
        turn: "t1",
        kind: "tool",
        call: "tool-1",
        name: "Read",
        args: { file_path: "a.ts" },
        status: "running",
      },
      agentText("a3", "done", "t1"),
    ];

    const groups = groupRenderItems(items);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "message",
      role: "agent",
      turn: "t1",
    });
    if (groups[0]?.kind !== "message") throw new Error("expected message group");
    expect(groups[0].items.map((item) => item.kind)).toEqual(["text", "tool", "text"]);
  });

  it("drops service rows from the visible transcript", () => {
    const items: RenderItem[] = [
      agentText("a1", "hello", "t1"),
      { id: "s1", time: 2, role: "agent", kind: "service", text: "Compacted history" },
      agentText("a2", "after service", "t1"),
    ];

    const groups = groupRenderItems(items);

    expect(groups).toHaveLength(1);
    if (groups[0]?.kind !== "message") throw new Error("expected message group");
    expect(groups[0].items).toHaveLength(2);
  });

  it("keeps user turns separate", () => {
    const items: RenderItem[] = [userText("u1", "first", "u-turn-1"), userText("u2", "second", "u-turn-2")];
    const groups = groupRenderItems(items);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.kind === "message")).toBe(true);
  });

  it("drops usage metadata while preserving non-empty subagent groups", () => {
    const items: RenderItem[] = [
      agentText("a1", "result", "t1"),
      {
        id: "u1",
        time: 2,
        role: "agent",
        turn: "t1",
        kind: "usage",
        inputTokens: 12,
        outputTokens: 4,
      },
      {
        id: "sub1",
        time: 3,
        role: "agent",
        kind: "subagent-group",
        subagentId: "task-1",
        items: [agentText("a2", "nested")],
      },
    ];

    const groups = groupRenderItems(items);

    expect(groups.map((group) => group.kind)).toEqual(["message", "standalone"]);
  });

  it("drops empty reasoning blocks", () => {
    const visibleItems = getVisibleTranscriptItems([
      agentText("a1", "   ", "t1", true),
      agentText("a2", "hello", "t1"),
    ]);

    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0]).toMatchObject({ kind: "text", md: "hello" });
  });
});
