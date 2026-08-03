import { describe, expect, it } from "vitest";
import type { ToolItem } from "@/sync/reducer";
import { CopyButton } from "../CopyButton";
import { BashCard } from "./BashCard";

function bashItem(args: Record<string, unknown>): ToolItem {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "tool",
    call: "c1",
    name: "Bash",
    args,
    status: "done",
  };
}

/** `BashCard`'s "Copy command" affordance. No hooks in `BashCard`/`ToolCardShell` themselves — `CopyButton`
 * only ever appears as an unrendered JSX child — so calling `BashCard`
 * directly and inspecting the plain element tree works without a render
 * environment, same technique `ToolCardShell.test.ts` uses. */
describe("BashCard — Copy command wiring", () => {
  function commandGroupChildren(item: ToolItem) {
    const shell = BashCard({ item });
    // ToolCardShell({item, icon, children}) — children is BashCard's JSX,
    // an array: [description|false, group/bash div, output branch].
    const shellChildren = shell.props.children as unknown[];
    const group = shellChildren[1] as { props: { children: unknown[] } };
    return group.props.children;
  }

  it("renders a CopyButton for the parsed command when one was captured", () => {
    const [, copyButton] = commandGroupChildren(bashItem({ command: "ls -la" })) as [
      unknown,
      { type: unknown; props: { getText: () => string; label: string } },
    ];
    expect(copyButton.type).toBe(CopyButton);
    expect(copyButton.props.getText()).toBe("ls -la");
    expect(copyButton.props.label).toBe("Copy command");
  });

  it("renders no CopyButton when no command was captured", () => {
    // `args.command && <CopyButton/>` short-circuits to the falsy
    // `args.command` itself (`undefined`, since it was never parsed) rather
    // than a literal `false` — either way, nothing renders.
    const [, copyButton] = commandGroupChildren(bashItem({}));
    expect(copyButton).toBeUndefined();
  });
});
