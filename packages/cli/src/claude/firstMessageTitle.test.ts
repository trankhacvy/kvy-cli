import { createEnvelope, type SessionEnvelope } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import { deriveTitleFromFirstUserMessage } from "./firstMessageTitle.js";

describe("deriveTitleFromFirstUserMessage", () => {
  it("returns the first line of the first genuine user text envelope", () => {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("agent", { t: "text", md: "hi, how can I help?" }),
      createEnvelope("user", { t: "text", md: "Fix the login redirect bug\nmore detail here" }),
    ];

    expect(deriveTitleFromFirstUserMessage(envelopes)).toBe("Fix the login redirect bug");
  });

  it("skips thinking blocks and subagent (sidechain) messages", () => {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("user", { t: "text", md: "internal task text", thinking: true }),
      createEnvelope("user", { t: "text", md: "sidechain text" }, { subagent: "sub-1" }),
      createEnvelope("user", { t: "text", md: "the real first message" }),
    ];

    expect(deriveTitleFromFirstUserMessage(envelopes)).toBe("the real first message");
  });

  it("strips a leading Conductor-style system_instruction wrapper", () => {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("user", {
        t: "text",
        md: "<system_instruction>some preamble\nmore preamble</system_instruction>\nthe real ask",
      }),
    ];

    expect(deriveTitleFromFirstUserMessage(envelopes)).toBe("the real ask");
  });

  it("truncates long first lines", () => {
    const long = "a".repeat(200);
    const envelopes: SessionEnvelope[] = [createEnvelope("user", { t: "text", md: long })];

    const title = deriveTitleFromFirstUserMessage(envelopes);
    expect(title).toHaveLength(120);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("returns null when there is no usable user text", () => {
    const envelopes: SessionEnvelope[] = [
      createEnvelope("agent", { t: "text", md: "assistant reply" }),
      createEnvelope("user", { t: "text", md: "   " }),
    ];

    expect(deriveTitleFromFirstUserMessage(envelopes)).toBeNull();
  });
});
