import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { PermissionInfo, ToolItem } from "@/sync/reducer";
import { AskUserQuestionCard } from "../AskUserQuestionCard";
import { PermCard } from "../PermCard";
import { ToolCardShell } from "./ToolCardShell";

function toolItem(name: string, permission?: PermissionInfo): ToolItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "tool",
    call: "c1",
    name,
    args: {},
    status: "done",
    permission,
  };
}

/** The permission section now lives inside AI Elements `ToolContent` after the
 * metadata row and the tool body slot. Reaching into the returned element tree
 * is still enough here; no render environment needed. */
function permissionSectionChildType(shell: ReactElement): unknown {
  const toolContent = (shell.props as { children: unknown[] }).children[1] as ReactElement | undefined;
  if (!toolContent) return undefined;
  const section = (toolContent.props as { children: unknown[] }).children[2] as
    | ReactElement
    | false
    | undefined;
  if (!section) return undefined;
  return (section.props as { children: ReactElement }).children.type;
}

describe("ToolCardShell — AskUserQuestion permission-section dispatch", () => {
  it("routes a pending AskUserQuestion permission to AskUserQuestionCard", () => {
    const item = toolItem("AskUserQuestion", { reqId: "r1", modes: [] });
    const shell = ToolCardShell({ item, children: null });
    expect(permissionSectionChildType(shell)).toBe(AskUserQuestionCard);
  });

  it("still routes a pending non-question permission to PermCard", () => {
    const item = toolItem("Bash", { reqId: "r1", modes: [] });
    const shell = ToolCardShell({ item, children: null });
    expect(permissionSectionChildType(shell)).toBe(PermCard);
  });

  it("renders no permission section once a decision exists", () => {
    const item = toolItem("AskUserQuestion", {
      reqId: "r1",
      modes: [],
      decision: { kind: "deny" },
    });
    const shell = ToolCardShell({ item, children: null });
    expect(permissionSectionChildType(shell)).toBeUndefined();
  });
});
