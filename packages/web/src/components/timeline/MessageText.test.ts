import { describe, expect, it } from "vitest";
import type { TextItem } from "@/sync/reducer";
import { CopyButton } from "./CopyButton";
import { MessageText } from "./MessageText";

function textItem(role: TextItem["role"], md: string): TextItem {
  return { id: "1", time: 0, role, kind: "text", md, thinking: false };
}

/** `MessageText`'s `CopyButton` wiring.
 * `Markdown` is only ever referenced as an unrendered JSX child here (never
 * invoked), so — same as `TimelineRow.test.ts`/`ToolCardShell.test.ts` —
 * calling `MessageText` directly and inspecting the plain element tree needs
 * no render environment and never touches the async unified/shiki
 * pipeline. */
describe("MessageText — CopyButton wiring", () => {
  it("copies the raw markdown from the assistant action row, not rendered output", () => {
    const el = MessageText({ item: textItem("agent", "**hello**") });
    // el -> outer div -> [Markdown, action-row div -> CopyButton]
    const [, actionRow] = el.props.children as [
      unknown,
      { props: { children: { type: unknown; props: unknown } } },
    ];
    const copyButton = actionRow.props.children;
    expect(copyButton.type).toBe(CopyButton);
    const props = copyButton.props as { getText: () => string };
    expect(props.getText()).toBe("**hello**");
  });

  it("renders the user message as a bordered box with no action row", () => {
    const el = MessageText({ item: textItem("user", "hi") });
    // el -> outer flex div -> single bordered-box child (Markdown inside, no CopyButton sibling).
    const box = el.props.children as { props: { className: string; children: unknown } };
    expect(box.props.className).toContain("border");
    expect(box.props.className).toContain("rounded-2xl");
    expect(JSON.stringify(el)).not.toContain("CopyButton");
  });

  it("still renders a ThinkingBlock for a thinking item, bypassing the copy-button row entirely", () => {
    const item: TextItem = {
      id: "1",
      time: 0,
      role: "agent",
      kind: "text",
      md: "reasoning",
      thinking: true,
    };
    const el = MessageText({ item });
    expect(el.props.md).toBe("reasoning");
  });
});
