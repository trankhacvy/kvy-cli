import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RenderItem } from "@/sync/reducer";
import { groupRenderItems, RenderItemGroups } from "./RenderItemGroups";
import { getVisibleTranscriptItems } from "./transcript-view";

function agentText(id: string, md: string, turn?: string, thinking = false): RenderItem {
  return {
    id,
    time: Number(id.replace(/\D/g, "")) || 0,
    role: "agent",
    kind: "text",
    md,
    turn,
    thinking,
  };
}

function userText(id: string, md: string, turn?: string): RenderItem {
  return {
    id,
    time: Number(id.replace(/\D/g, "")) || 0,
    role: "user",
    kind: "text",
    md,
    turn,
    thinking: false,
  };
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

  it("drops quiet (routine boundary) service rows from the visible transcript", () => {
    const items: RenderItem[] = [
      agentText("a1", "hello", "t1"),
      { id: "s1", time: 2, role: "agent", kind: "service", text: "session started", quiet: true },
      agentText("a2", "after service", "t1"),
    ];

    const groups = groupRenderItems(items);

    expect(groups).toHaveLength(1);
    if (groups[0]?.kind !== "message") throw new Error("expected message group");
    expect(groups[0].items).toHaveLength(2);
  });

  it("keeps a non-quiet service row visible, as its own standalone group between messages", () => {
    const serviceText = "Set model to Haiku 4.5 and saved as your default for new sessions";
    const items: RenderItem[] = [
      agentText("a1", "hello", "t1"),
      { id: "s1", time: 2, role: "agent", kind: "service", text: serviceText, quiet: false },
      agentText("a2", "after service", "t1"),
    ];

    const groups = groupRenderItems(items);

    expect(groups.map((g) => g.kind)).toEqual(["message", "standalone", "message"]);
    if (groups[1]?.kind !== "standalone") throw new Error("expected standalone group");
    expect(groups[1].item).toMatchObject({ kind: "service", text: serviceText });
  });

  it("keeps a plan item visible, as its own standalone group between messages", () => {
    const items: RenderItem[] = [
      agentText("a1", "working on it", "t1"),
      {
        id: "p1",
        time: 2,
        role: "agent",
        turn: "t1",
        kind: "plan",
        steps: [{ text: "List files", status: "completed" }],
      },
      agentText("a2", "done", "t1"),
    ];

    const groups = groupRenderItems(items);

    expect(groups.map((g) => g.kind)).toEqual(["message", "standalone", "message"]);
    if (groups[1]?.kind !== "standalone") throw new Error("expected standalone group");
    expect(groups[1].item).toMatchObject({ kind: "plan" });
  });

  it("keeps user turns separate", () => {
    const items: RenderItem[] = [
      userText("u1", "first", "u-turn-1"),
      userText("u2", "second", "u-turn-2"),
    ];
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

describe("RenderItemGroups (Issue #8 — no internal subagentId leaks into visible text)", () => {
  it("labels standalone subagent groups with a per-render ordinal, not the raw cuid2", () => {
    const items: RenderItem[] = [
      {
        id: "sub1",
        time: 1,
        role: "agent",
        kind: "subagent-group",
        subagentId: "tz4a98xxat96iws9zmbrgioa",
        items: [agentText("a1", "first subagent's work")],
      },
      {
        id: "sub2",
        time: 2,
        role: "agent",
        kind: "subagent-group",
        subagentId: "k3f8p2q9wjr1n6yz0lce4dgs",
        items: [agentText("a2", "second subagent's work")],
      },
    ];

    const html = renderToStaticMarkup(createElement(RenderItemGroups, { items }));

    expect(html).toContain("Subagent 1");
    expect(html).toContain("Subagent 2");
    expect(html).not.toContain("tz4a98xxat96iws9zmbrgioa");
    expect(html).not.toContain("k3f8p2q9wjr1n6yz0lce4dgs");
  });

  it("actually renders a plan checklist's steps into the transcript markup", () => {
    const items: RenderItem[] = [
      {
        id: "p1",
        time: 1,
        role: "agent",
        kind: "plan",
        steps: [
          { text: "List files", status: "completed" },
          { text: "Write hello.txt", status: "in_progress" },
        ],
      },
    ];

    const html = renderToStaticMarkup(createElement(RenderItemGroups, { items }));

    expect(html).toContain("List files");
    expect(html).toContain("Write hello.txt");
  });
});
