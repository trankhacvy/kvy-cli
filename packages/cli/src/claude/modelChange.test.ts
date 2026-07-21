import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import {
  extractClaudeModelChangeFromText,
  findClaudeModelChangeInEnvelopes,
} from "./modelChange.js";

describe("extractClaudeModelChangeFromText", () => {
  it("parses a normal /model success message", () => {
    expect(
      extractClaudeModelChangeFromText("Set model to Haiku 4.5 and saved as your default for new sessions."),
    ).toBe("Haiku 4.5");
  });

  it("strips ANSI control sequences and orphaned markers", () => {
    expect(
      extractClaudeModelChangeFromText(
        "Set model to \u001b[1mHaiku 4.5\u001b[22m and saved as your default for new sessions [blocked]",
      ),
    ).toBe("Haiku 4.5");
    expect(extractClaudeModelChangeFromText("Set model to [1mSonnet[22m.")).toBe("Sonnet");
  });

  it("ignores unrelated assistant text", () => {
    expect(extractClaudeModelChangeFromText("I can help with that.")).toBeNull();
  });
});

describe("findClaudeModelChangeInEnvelopes", () => {
  it("returns the latest matching agent text envelope", () => {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("user", { t: "text", md: "/model", thinking: false }),
      createEnvelope("agent", { t: "text", md: "Set model to Sonnet.", thinking: false }),
      createEnvelope("agent", { t: "text", md: "Set model to Opus.", thinking: false }),
    ];

    expect(findClaudeModelChangeInEnvelopes(envelopes)).toBe("Opus");
  });

  it("ignores thinking envelopes", () => {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("agent", { t: "text", md: "Set model to Opus.", thinking: true }),
    ];

    expect(findClaudeModelChangeInEnvelopes(envelopes)).toBeNull();
  });
});
