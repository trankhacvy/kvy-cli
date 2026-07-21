import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { ToolItem } from "@/sync/reducer";
import { Markdown } from "../Markdown";
import { ExitPlanModeToolCard } from "./ExitPlanModeToolCard";

function toolItem(args: unknown): ToolItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "tool",
    call: "c1",
    name: "ExitPlanMode",
    args,
    status: "done",
  };
}

/** `ExitPlanModeToolCard`'s body slot (bug-fix-plan.md #6) — same
 * calling-directly-and-inspecting-the-element-tree technique
 * `BashCard.test.ts` uses: `ExitPlanModeToolCard({item})` returns the JSX
 * element `<ToolCardShell item={item} icon={...}>{body}</ToolCardShell>`
 * *unrendered* (JSX always goes through `createElement`, never invokes the
 * component function), so `.type` is `ToolCardShell` and `.props.children`
 * is exactly the body element passed in — no render environment needed. */
function cardBody(item: ToolItem): unknown {
  const shell = ExitPlanModeToolCard({ item }) as ReactElement;
  return (shell.props as { children: unknown }).children;
}

describe("ExitPlanModeToolCard", () => {
  it("renders the plan markdown when a plan string is present", () => {
    const body = cardBody(toolItem({ plan: "# Step 1\n\nDo the thing." })) as ReactElement;
    expect(body.type).toBe(Markdown);
    expect((body.props as { md: string }).md).toBe("# Step 1\n\nDo the thing.");
  });

  it("falls back to a safe message when args has no plan field", () => {
    const body = cardBody(toolItem({})) as ReactElement;
    expect(body.type).toBe("p");
    expect((body.props as { children: string }).children).toBe("No plan text recorded.");
  });

  it("falls back to a safe message when args is malformed (non-object)", () => {
    const body = cardBody(toolItem("not an object")) as ReactElement;
    expect(body.type).toBe("p");
    expect((body.props as { children: string }).children).toBe("No plan text recorded.");
  });

  it("falls back to a safe message when plan is present but not a string", () => {
    const body = cardBody(toolItem({ plan: 12345 })) as ReactElement;
    expect(body.type).toBe("p");
    expect((body.props as { children: string }).children).toBe("No plan text recorded.");
  });

  it("falls back to a safe message when args is undefined", () => {
    const body = cardBody(toolItem(undefined)) as ReactElement;
    expect(body.type).toBe("p");
    expect((body.props as { children: string }).children).toBe("No plan text recorded.");
  });

  it("falls back to a safe message when args is null or an array", () => {
    const nullBody = cardBody(toolItem(null)) as ReactElement;
    expect(nullBody.type).toBe("p");
    expect((nullBody.props as { children: string }).children).toBe("No plan text recorded.");

    const arrayBody = cardBody(toolItem(["not", "an", "object"])) as ReactElement;
    expect(arrayBody.type).toBe("p");
    expect((arrayBody.props as { children: string }).children).toBe("No plan text recorded.");
  });
});
