import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { PermissionInfo, ToolItem } from "@/sync/reducer";
import { AskQuestionOptions } from "../AskQuestionOptions";
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
    args: {
      questions: [{ question: "Which color?", options: ["Red", "Blue"] }],
    },
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

/** Text content of a `<p>{text}</p>`-shaped element. */
function textOf(el: ReactElement): unknown {
  return (el.props as { children: unknown }).children;
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
    const body = bodyOf(toolItem({ permission: decidedPermission, output: { answers: {} } }));
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

    const firstRow = questionRows[0] as ReactElement;
    const [firstQ, firstA] = (firstRow.props as { children: ReactElement[] }).children;
    expect(textOf(firstQ as ReactElement)).toBe("Which color?");
    expect(textOf(firstA as ReactElement)).toBe("Blue");

    const secondRow = questionRows[1] as ReactElement;
    const [secondQ, secondA] = (secondRow.props as { children: ReactElement[] }).children;
    expect(textOf(secondQ as ReactElement)).toBe("Which size?");
    expect(textOf(secondA as ReactElement)).toBe("L");

    // No fallback JsonBlock once every answer was recognized.
    expect(children[1]).toBe(false);
  });

  it("renders a web-answered free-text question with its real answer, and does not mark it as an Error/failed card, even though the wire-level tool result carries ok:false", () => {
    // docs/known-issues-cliweb-sync-test.md issue #4: a free-text (or any web-turn)
    // AskUserQuestion answer only reaches Claude via a denied tool call whose reason
    // carries the real answer (`composeAskAnswerReason` in `pretoolPermissionBridge.ts`)
    // — `item.ok` is `false` on the wire even though this is a normal, successful answer.
    const shell = AskUserQuestionToolCard({
      item: toolItem({
        args: { questions: [{ question: "Pick a fruit", options: ["Apple", "Banana"] }] },
        ok: false,
        output:
          "The user answered via the Kvy web UI:\n- Pick a fruit\n  → Mango\nProceed using these answers. Do not call AskUserQuestion again for these questions.",
      }),
    });

    expect(shell.type).toBe(ToolCardShell);
    // Not "failed"/"Error" despite `item.ok === false` — the card's own status is
    // decoupled from the underlying wire-protocol-level `is_error` marking.
    expect((shell.props as { statusLabel?: string }).statusLabel).toBe("done");
    expect((shell.props as { statusVariant?: string }).statusVariant).toBe("success");
    expect((shell.props as { toolStateOverride?: string }).toolStateOverride).toBe(
      "output-available",
    );

    const body = (shell.props as { children: ReactElement }).children;
    const children = (body.props as { children: unknown[] }).children;
    const questionRows = children[0] as ReactElement[];
    const row = questionRows[0] as ReactElement;
    const [, answerP] = (row.props as { children: ReactElement[] }).children;
    expect(textOf(answerP as ReactElement)).toBe("Mango");

    // The real answer was recognized, so no raw JsonBlock fallback either.
    expect(children[1]).toBe(false);
  });

  it("renders options for a top-level single-question arg shape", () => {
    const body = bodyOf(
      toolItem({
        args: {
          question: "Which approach should I take?",
          options: ["A", "B"],
        },
        output: { answers: { "Which approach should I take?": "A" } },
      }),
    );
    const children = (body.props as { children: unknown[] }).children;
    const questionRows = children[0] as ReactElement[];
    const row = questionRows[0] as ReactElement;
    const rowChildren = (row.props as { children: ReactElement[] }).children;
    expect(textOf(rowChildren[0] as ReactElement)).toBe("Which approach should I take?");
    expect((rowChildren[2] as ReactElement).type).toBe(AskQuestionOptions);
  });

  it("renders a declined question as a neutral outcome instead of a failure", () => {
    const shell = AskUserQuestionToolCard({
      item: toolItem({
        ok: false,
        output:
          "The remote user did not answer the structured question form. Ask the same question(s) again in PLAIN TEXT in your reply (no AskUserQuestion tool), then end your turn and wait for the user's typed answer.",
      }),
    });

    expect(shell.type).toBe(ToolCardShell);
    expect((shell.props as { statusLabel?: string }).statusLabel).toBe("declined");
    expect((shell.props as { statusVariant?: string }).statusVariant).toBe("secondary");

    const body = (shell.props as { children: ReactElement }).children;
    expect(body.type).toBe("div");
  });

  it("falls back to (no answer recorded) and a raw JsonBlock for an unrecognized output shape", () => {
    const output = { somethingElse: true };
    const body = bodyOf(toolItem({ output }));

    const children = (body.props as { children: unknown[] }).children;
    const questionRows = children[0] as ReactElement[];
    const row = questionRows[0] as ReactElement;
    const [, answerP] = (row.props as { children: ReactElement[] }).children;
    expect(textOf(answerP as ReactElement)).toBe("(no answer recorded)");

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
