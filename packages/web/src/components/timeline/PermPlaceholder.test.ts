import { describe, expect, it } from "vitest";
import type { PermPlaceholderItem } from "@/sync/reducer";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { PermCard } from "./PermCard";
import { PermPlaceholder } from "./PermPlaceholder";

function placeholder(name: string, decision?: PermPlaceholderItem["permission"]["decision"]) {
  return {
    id: "1",
    time: 0,
    role: "agent",
    kind: "perm-placeholder",
    name,
    args: {},
    permission: { reqId: "r1", modes: [], decision },
  } satisfies PermPlaceholderItem;
}

/** `PermPlaceholder`'s dispatch — verified the same way as
 * the registry's own dispatch test: calling the function directly returns a
 * plain `React.createElement(...)` object, no render environment needed. */
describe("PermPlaceholder — AskUserQuestion dispatch", () => {
  it("routes AskUserQuestion to its own card regardless of decision state", () => {
    expect(PermPlaceholder({ item: placeholder("AskUserQuestion") }).type).toBe(
      AskUserQuestionCard,
    );
    expect(PermPlaceholder({ item: placeholder("AskUserQuestion", { kind: "deny" }) }).type).toBe(
      AskUserQuestionCard,
    );
  });

  it("routes ask_user_question to its own card too", () => {
    expect(PermPlaceholder({ item: placeholder("ask_user_question") }).type).toBe(
      AskUserQuestionCard,
    );
  });

  it("still routes a pending non-question tool to PermCard", () => {
    expect(PermPlaceholder({ item: placeholder("Bash") }).type).toBe(PermCard);
  });
});
