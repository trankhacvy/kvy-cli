import { describe, expect, it } from "vitest";
import { applyMentionSelection, findMentionTrigger } from "../mention-trigger";

describe("findMentionTrigger", () => {
  it("triggers immediately on a bare '@' with an empty query", () => {
    expect(findMentionTrigger("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("triggers mid-word after '@' at the start of the text", () => {
    expect(findMentionTrigger("@CLA", 4)).toEqual({ start: 0, end: 4, query: "CLA" });
  });

  it("triggers after whitespace", () => {
    const text = "please check @plan";
    expect(findMentionTrigger(text, text.length)).toEqual({
      start: 13,
      end: 18,
      query: "plan",
    });
  });

  it("triggers with the cursor mid-query, not just at the end of text", () => {
    // "@pla|n.md" — cursor between 'a' and 'n'
    const text = "@plan.md";
    expect(findMentionTrigger(text, 4)).toEqual({ start: 0, end: 4, query: "pla" });
  });

  it("does not trigger for an email-like '@' preceded by a non-whitespace character", () => {
    const text = "contact me@x";
    expect(findMentionTrigger(text, text.length)).toBeNull();
  });

  it("does not trigger once whitespace has been typed after the '@'", () => {
    const text = "@foo bar";
    expect(findMentionTrigger(text, text.length)).toBeNull();
  });

  it("does not trigger when there is no '@' before the cursor at all", () => {
    expect(findMentionTrigger("hello world", 5)).toBeNull();
  });

  it("returns null at cursor 0 (nothing typed yet)", () => {
    expect(findMentionTrigger("@foo", 0)).toBeNull();
  });

  it("does not trigger when the closest preceding '@' is itself glued to a non-whitespace character", () => {
    // The nearest "@" (index 2) is immediately preceded by "a" — same
    // email-like rule as the "contact me@x" case above, just with another
    // "@" further back in the string that must NOT be found instead: only
    // the nearest "@" to the cursor is ever considered.
    const text = "@a@bc";
    expect(findMentionTrigger(text, text.length)).toBeNull();
  });
});

describe("applyMentionSelection", () => {
  it("replaces the '@query' span with '@<path> ' and places the caret right after the inserted space", () => {
    const text = "please check @pla done";
    const typedSoFar = "please check @pla";
    const trigger = findMentionTrigger(typedSoFar, typedSoFar.length);
    expect(trigger).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const result = applyMentionSelection(text, trigger!, "plan.md");
    expect(result.text).toBe("please check @plan.md  done");
    expect(result.cursor).toBe("please check @plan.md ".length);
    expect(result.text.slice(0, result.cursor)).toBe("please check @plan.md ");
  });

  it("works when the trigger is the entire text", () => {
    const trigger = findMentionTrigger("@", 1);
    // biome-ignore lint/style/noNonNullAssertion: asserted by the trigger test above
    const result = applyMentionSelection("@", trigger!, "CLAUDE.md");
    expect(result).toEqual({ text: "@CLAUDE.md ", cursor: "@CLAUDE.md ".length });
  });
});
