import { describe, expect, it } from "vitest";
import type { ToolItem } from "@/sync/reducer";
import { AskUserQuestionToolCard } from "./AskUserQuestionToolCard";
import { ExitPlanModeToolCard } from "./ExitPlanModeToolCard";
import { LsCard } from "./LsCard";
import { McpGenericCard } from "./McpGenericCard";
import { NotebookEditCard } from "./NotebookEditCard";
import { ToolCard } from "./registry";
import { TaskEntryCard } from "./TaskEntryCard";
import { WebFetchCard } from "./WebFetchCard";
import { WebSearchCard } from "./WebSearchCard";

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

describe("ToolCard registry — AskUserQuestion dispatch", () => {
  it("routes both AskUserQuestion tool-name spellings to AskUserQuestionToolCard", () => {
    expect(ToolCard({ item: toolItem("AskUserQuestion") }).type).toBe(AskUserQuestionToolCard);
    expect(ToolCard({ item: toolItem("ask_user_question") }).type).toBe(AskUserQuestionToolCard);
  });

  it("still falls back to McpGenericCard for an unregistered tool", () => {
    expect(ToolCard({ item: toolItem("SomeUnknownTool") }).type).toBe(McpGenericCard);
  });
});

/** Tool-card registry parity coverage additions: `WebFetch`,
 * `WebSearch`, `NotebookEdit`, `LS`. */
describe("ToolCard registry — coverage cards", () => {
  it("routes WebFetch to WebFetchCard", () => {
    expect(ToolCard({ item: toolItem("WebFetch") }).type).toBe(WebFetchCard);
  });

  it("routes WebSearch to WebSearchCard", () => {
    expect(ToolCard({ item: toolItem("WebSearch") }).type).toBe(WebSearchCard);
  });

  it("routes NotebookEdit to NotebookEditCard", () => {
    expect(ToolCard({ item: toolItem("NotebookEdit") }).type).toBe(NotebookEditCard);
  });

  it("routes LS to LsCard", () => {
    expect(ToolCard({ item: toolItem("LS") }).type).toBe(LsCard);
  });
});

/** `ExitPlanMode` previously fell through to the raw-JSON
 * `McpGenericCard` fallback like any unregistered tool. */
describe("ToolCard registry — ExitPlanMode dispatch", () => {
  it("routes both ExitPlanMode tool-name spellings to ExitPlanModeToolCard", () => {
    expect(ToolCard({ item: toolItem("ExitPlanMode") }).type).toBe(ExitPlanModeToolCard);
    expect(ToolCard({ item: toolItem("exit_plan_mode") }).type).toBe(ExitPlanModeToolCard);
  });

  it("does not fall back to McpGenericCard for either spelling", () => {
    expect(ToolCard({ item: toolItem("ExitPlanMode") }).type).not.toBe(McpGenericCard);
    expect(ToolCard({ item: toolItem("exit_plan_mode") }).type).not.toBe(McpGenericCard);
  });
});

/** `TaskCreate`/`TaskUpdate` (Claude Code's current
 * task/checklist tool pair, replacing `TodoWrite`) previously fell through
 * to the raw-JSON `McpGenericCard` fallback like any unregistered tool. */
describe("ToolCard registry — TaskCreate/TaskUpdate dispatch", () => {
  it("routes both TaskCreate and TaskUpdate to TaskEntryCard", () => {
    expect(ToolCard({ item: toolItem("TaskCreate") }).type).toBe(TaskEntryCard);
    expect(ToolCard({ item: toolItem("TaskUpdate") }).type).toBe(TaskEntryCard);
  });

  it("does not fall back to McpGenericCard for either tool name", () => {
    expect(ToolCard({ item: toolItem("TaskCreate") }).type).not.toBe(McpGenericCard);
    expect(ToolCard({ item: toolItem("TaskUpdate") }).type).not.toBe(McpGenericCard);
  });
});
