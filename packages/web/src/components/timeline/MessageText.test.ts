import { describe, expect, it } from "vitest";
import type { TextItem } from "@/sync/reducer";
import { CopyButton } from "./CopyButton";
import { MessageText } from "./MessageText";

function textItem(role: TextItem["role"], md: string): TextItem {
  return { id: "1", time: 0, role, kind: "text", md, thinking: false };
}

/** `MessageText`'s new `CopyButton` wiring (plan-v2.md W4.2 "Copy buttons").
 * `Markdown` is only ever referenced as an unrendered JSX child here (never
 * invoked), so — same as `TimelineRow.test.ts`/`ToolCardShell.test.ts` —
 * calling `MessageText` directly and inspecting the plain element tree needs
 * no render environment and never touches the async unified/shiki
 * pipeline. */
describe("MessageText — CopyButton wiring", () => {
  it("copies the raw markdown, not rendered output", () => {
    const el = MessageText({ item: textItem("agent", "**hello**") });
    // el -> outer flex div -> "relative" wrapper div -> [bubble div, CopyButton]
    const wrapper = el.props.children as { props: { children: unknown[] } };
    const [, copyButton] = wrapper.props.children as [unknown, { type: unknown; props: unknown }];
    expect(copyButton.type).toBe(CopyButton);
    const props = copyButton.props as { getText: () => string };
    expect(props.getText()).toBe("**hello**");
  });

  it("anchors the button to the opposite side for a user bubble vs. an agent bubble", () => {
    const agentButton = (
      (MessageText({ item: textItem("agent", "hi") }).props as { children: { props: { children: unknown[] } } })
        .children.props.children[1] as { props: { className: string } }
    ).props.className;
    const userButton = (
      (MessageText({ item: textItem("user", "hi") }).props as { children: { props: { children: unknown[] } } })
        .children.props.children[1] as { props: { className: string } }
    ).props.className;

    expect(agentButton).toContain("-right-2");
    expect(userButton).toContain("-left-2");
  });

  it("still renders a ThinkingBlock for a thinking item, bypassing the copy-button bubble entirely", () => {
    const item: TextItem = { id: "1", time: 0, role: "agent", kind: "text", md: "reasoning", thinking: true };
    const el = MessageText({ item });
    expect(el.props.md).toBe("reasoning");
  });
});
