import { describe, expect, it } from "vitest";
import { thinkingBlockLabel } from "./ThinkingBlock";

describe("thinkingBlockLabel", () => {
  it("reads past-tense when collapsed — a rendered thinking block is always historical (W1.7)", () => {
    expect(thinkingBlockLabel(false)).toBe("Thought process");
  });

  it("reads as an action verb while open", () => {
    expect(thinkingBlockLabel(true)).toBe("Hide thinking");
  });
});
