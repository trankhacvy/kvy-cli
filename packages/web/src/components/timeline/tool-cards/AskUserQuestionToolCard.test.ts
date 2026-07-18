import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { PermissionInfo, ToolItem } from "@/sync/reducer";
import { JsonBlock } from "../JsonBlock";
import { AskUserQuestionToolCard } from "./AskUserQuestionToolCard";
import { ToolCardShell } from "./ToolCardShell";

function toolItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "tool",
    call: "c1",
    name: "AskUserQuestion",
    args: { questions: [{ question: "Which color?", options: ["Red", "Blue"] }] },
    status: "done",
    ...overrides,
  };
}

/** `AskUserQuestionToolCard` has no hooks of its own (unlike `PermCard`/
 * `AskUserQuestionCard`), so — unlike those — its actual body content is
 * directly introspectable via the same "call the function, walk the plain
 * `React.createElement(...)` object" technique the dispatch tests use
 * (plan-v2.md W2.1's "read-only ToolCard" sub-task). It always wraps its
 * body in `ToolCardShell`, so every case below unwraps one level first. */
function bodyOf(item: ToolItem): ReactElement {
  const shell = AskUserQuestionToolCard({ item });
  expect(shell.type).toBe(ToolCardShell);
  return (shell.props as { children: ReactElement }).children;
}

describe("AskUserQuestionToolCard", () => {
  it("shows a waiting message while the permission is still pending", () => {
    const pendingPermission: PermissionInfo = { reqId: "r1", modes: [] };
    const body = bodyOf(toolItem({ permission: pendingPermission }));

    expect(body.type).toBe("p");
    expect((body.props as { children: unknown }).children).toBe("Waiting for an answer…");
  });

  it("does not treat a decided permission as pending", () => {
    const decidedPermission: PermissionInfo = {
      reqId: "r1",
      modes: [],
      decision: { kind: "deny" },
    };
    const body = bodyOf(
      toolItem({ permission: decidedPermission, output: { answers: {} } }),
    );
    expect(body.type).toBe("div");
  });

  it("renders each question with its recognized answer, no JsonBlock fallback", () => {
    const body = bodyOf(
      toolItem({
        args: {
          questions: [
            { question: "Which color?", options: ["Red", "Blue"] },
            { question: "Which size?", options: ["S", "L"] },
          ],
        },
        output: { answers: { "Which color?": "Blue", "Which size?": "L" } },
      }),
    );

    const children = (body.props as { children: unknown[] }).children;
    const questionRows = children[0] as ReactElement[];
    expect(questionRows).toHaveLength(2);

    const [firstQ, firstA] = (questionRows[0]?.props as { children: ReactElement[] }).children;
    expect((firstQ?.props as { children: string }).children).toBe("Which color?");
    expect((firstA?.props as { children: string }).children).toBe("Blue");

    const [secondQ, secondA] = (questionRows[1]?.props as { children: ReactElement[] }).children;
    expect((secondQ?.props as { children: string }).children).toBe("Which size?");
    expect((secondA?.props as { children: string }).children).toBe("L");

    // No fallback JsonBlock once every answer was recognized.
    expect(children[1]).toBe(false);
  });

  it("falls back to (no answer recorded) and a raw JsonBlock for an unrecognized output shape", () => {
    const output = { somethingElse: true };
    const body = bodyOf(toolItem({ output }));

    const children = (body.props as { children: unknown[] }).children;
    const questionRows = children[0] as ReactElement[];
    const [, answerP] = (questionRows[0]?.props as { children: ReactElement[] }).children;
    expect((answerP?.props as { children: string }).children).toBe("(no answer recorded)");

    const fallback = children[1] as ReactElement;
    expect(fallback.type).toBe(JsonBlock);
    expect((fallback.props as { value: unknown }).value).toBe(output);
  });

  it("omits the JsonBlock fallback entirely when there is no output yet", () => {
    const body = bodyOf(toolItem({ output: undefined }));
    const children = (body.props as { children: unknown[] }).children;
    expect(children[1]).toBe(false);
  });
});
