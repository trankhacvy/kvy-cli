import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { ToolItem } from "@/sync/reducer";
import { TaskEntryCard } from "./TaskEntryCard";

function toolItem(name: string, args: unknown): ToolItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "tool",
    call: "c1",
    name,
    args,
    status: "done",
  };
}

/** Same calling-directly-and-inspecting-the-element-tree technique
 * `ExitPlanModeToolCard.test.ts`/`BashCard.test.ts` use: `TaskEntryCard({item})`
 * returns the JSX element `<ToolCardShell item={item} icon={...}>{body}</ToolCardShell>`
 * *unrendered*, so `.props.children` is exactly the body element passed in —
 * no render environment needed. */
function cardBody(item: ToolItem): ReactElement {
  const shell = TaskEntryCard({ item }) as ReactElement;
  return (shell.props as { children: ReactElement }).children;
}

/** Digs into the body's own children array to find the heading/status/
 * description text nodes rendered by `TaskEntryCard` (a `<div>` of
 * `<span>`/`<p>` children under the status-indicator row). */
function textsIn(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(textsIn);
  const element = node as ReactElement;
  const children = (element.props as { children?: unknown } | undefined)?.children;
  return textsIn(children);
}

describe("TaskEntryCard — TaskCreate", () => {
  // Real shape from packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl
  it("renders subject, description, and a 'New task' status for a real TaskCreate call", () => {
    const body = cardBody(
      toolItem("TaskCreate", {
        subject: "Prune merged workflow worktrees and branches",
        description: "Remove .worktrees/* entries whose branches are fully merged into main.",
        activeForm: "Pruning merged worktrees",
      }),
    );
    const texts = textsIn(body);
    expect(texts).toContain("Prune merged workflow worktrees and branches");
    expect(texts).toContain(
      "Remove .worktrees/* entries whose branches are fully merged into main.",
    );
    expect(texts).toContain("New task");
  });

  it("falls back to '(untitled task)' when subject is missing", () => {
    const body = cardBody(toolItem("TaskCreate", {}));
    expect(textsIn(body)).toContain("(untitled task)");
  });

  it("does not crash on malformed (non-object) args", () => {
    const body = cardBody(toolItem("TaskCreate", "not an object"));
    expect(textsIn(body)).toContain("(untitled task)");
  });
});

describe("TaskEntryCard — TaskUpdate", () => {
  // Real shape: a TaskUpdate call is a partial patch, never the full list.
  it("renders the task id and status transition for a real TaskUpdate call", () => {
    const body = cardBody(toolItem("TaskUpdate", { taskId: "1", status: "in_progress" }));
    const texts = textsIn(body);
    expect(texts).toContain("Task #1 — In progress");
  });

  it("renders a completed status with strikethrough styling on the heading", () => {
    const body = cardBody(toolItem("TaskUpdate", { taskId: "1", status: "completed" }));
    const element = body as ReactElement;
    // heading span is the first child of the text column
    const textColumn = (element.props as { children: ReactElement[] }).children[1] as ReactElement;
    const heading = (textColumn.props as { children: ReactElement[] }).children[0] as ReactElement;
    expect((heading.props as { className: string }).className).toContain("line-through");
  });

  it("falls back to a task-id-only heading when no subject is present on the update", () => {
    const body = cardBody(toolItem("TaskUpdate", { taskId: "7", status: "completed" }));
    expect(textsIn(body)).toContain("Task #7");
  });

  it("handles a metadata-only update with no status as 'Updated' instead of crashing", () => {
    const body = cardBody(
      toolItem("TaskUpdate", { taskId: "2", description: "Merged to main as f9c3ba9." }),
    );
    const texts = textsIn(body);
    expect(texts).toContain("Merged to main as f9c3ba9.");
    expect(texts).toContain("Task #2 — Updated");
  });

  it("also reads the older task_id spelling", () => {
    const body = cardBody(toolItem("TaskUpdate", { task_id: "3", status: "completed" }));
    expect(textsIn(body)).toContain("Task #3 — Completed");
  });

  it("does not crash on malformed (non-object) args", () => {
    const body = cardBody(toolItem("TaskUpdate", "not an object"));
    expect(textsIn(body)).toContain("(untitled task)");
  });
});
