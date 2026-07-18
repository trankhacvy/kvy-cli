import { describe, expect, it } from "vitest";
import type { ToolItem } from "@/sync/reducer";
import { AskUserQuestionToolCard } from "./AskUserQuestionToolCard";
import { McpGenericCard } from "./McpGenericCard";
import { ToolCard } from "./registry";

function toolItem(name: string): ToolItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "tool",
    call: "c1",
    name,
    args: {},
    status: "done",
  };
}

/** `ToolCard`'s dispatch (plan-v2.md W2.1's "read-only ToolCard + registry"
 * sub-task) — calling it directly returns the `React.createElement(...)`
 * result, a plain object carrying `.type`, so the dispatch is verifiable
 * without a DOM/render environment (this package has neither). */
describe("ToolCard registry — AskUserQuestion dispatch", () => {
  it("routes both AskUserQuestion tool-name spellings to AskUserQuestionToolCard", () => {
    expect(ToolCard({ item: toolItem("AskUserQuestion") }).type).toBe(AskUserQuestionToolCard);
    expect(ToolCard({ item: toolItem("ask_user_question") }).type).toBe(AskUserQuestionToolCard);
  });

  it("still falls back to McpGenericCard for an unregistered tool", () => {
    expect(ToolCard({ item: toolItem("SomeUnknownTool") }).type).toBe(McpGenericCard);
  });
});
