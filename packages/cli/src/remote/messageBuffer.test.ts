import { createEnvelope } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { MessageBuffer, pushEnvelopeToBuffer, summarizeEnvelope } from "./messageBuffer.js";

describe("MessageBuffer", () => {
  it("accumulates messages and notifies listeners with the full current list", () => {
    const buffer = new MessageBuffer();
    const seen: string[][] = [];
    buffer.onUpdate((messages) => seen.push(messages.map((m) => m.content)));

    buffer.addMessage("one", "status");
    buffer.addMessage("two", "assistant");

    expect(seen).toEqual([["one"], ["one", "two"]]);
    expect(buffer.getMessages().map((m) => m.kind)).toEqual(["status", "assistant"]);
  });

  it("clear() empties the buffer and notifies with an empty list", () => {
    const buffer = new MessageBuffer();
    buffer.addMessage("one");
    buffer.clear();
    expect(buffer.getMessages()).toEqual([]);
  });

  it("unsubscribe stops further notifications", () => {
    const buffer = new MessageBuffer();
    const seen: string[][] = [];
    const unsubscribe = buffer.onUpdate((messages) => seen.push(messages.map((m) => m.content)));
    unsubscribe();
    buffer.addMessage("ignored");
    expect(seen).toEqual([]);
  });

  it("getMessages() returns a snapshot copy, not a live reference", () => {
    const buffer = new MessageBuffer();
    buffer.addMessage("one");
    const snapshot = buffer.getMessages();
    buffer.addMessage("two");
    expect(snapshot).toHaveLength(1);
  });
});

describe("summarizeEnvelope", () => {
  it("summarizes a user text envelope", () => {
    const envelope = createEnvelope("user", { t: "text", md: "hello" });
    expect(summarizeEnvelope(envelope)).toEqual({ content: "You: hello", kind: "user" });
  });

  it("summarizes an assistant text envelope", () => {
    const envelope = createEnvelope("agent", { t: "text", md: "hi there" });
    expect(summarizeEnvelope(envelope)).toEqual({ content: "Claude: hi there", kind: "assistant" });
  });

  it("summarizes a thinking envelope distinctly", () => {
    const envelope = createEnvelope("agent", { t: "text", md: "pondering", thinking: true });
    expect(summarizeEnvelope(envelope)).toEqual({
      content: "(thinking) pondering",
      kind: "assistant",
    });
  });

  it("summarizes tool-start with its title when present", () => {
    const envelope = createEnvelope("agent", {
      t: "tool-start",
      call: "c1",
      name: "Bash",
      title: "Run tests",
      args: {},
    });
    expect(summarizeEnvelope(envelope)).toEqual({ content: "🔧 Run tests", kind: "tool" });
  });

  it("summarizes tool-end ok/failed", () => {
    const ok = createEnvelope("agent", { t: "tool-end", call: "c1", ok: true });
    const failed = createEnvelope("agent", { t: "tool-end", call: "c1", ok: false });
    expect(summarizeEnvelope(ok)?.content).toBe("✅ done");
    expect(summarizeEnvelope(failed)?.content).toBe("❌ failed");
  });

  it("returns null for turn-start and a completed turn-end", () => {
    expect(summarizeEnvelope(createEnvelope("agent", { t: "turn-start" }))).toBeNull();
    expect(
      summarizeEnvelope(createEnvelope("agent", { t: "turn-end", status: "completed" })),
    ).toBeNull();
  });

  it("summarizes a non-completed turn-end", () => {
    const envelope = createEnvelope("agent", { t: "turn-end", status: "failed" });
    expect(summarizeEnvelope(envelope)).toEqual({ content: "Turn failed", kind: "status" });
  });

  it("returns null for usage (web-only chip, W4.6)", () => {
    const envelope = createEnvelope("agent", { t: "usage", inputTokens: 4, outputTokens: 5 });
    expect(summarizeEnvelope(envelope)).toBeNull();
  });

  it("returns null for plan (web-only checklist widget)", () => {
    const envelope = createEnvelope("agent", {
      t: "plan",
      steps: [{ text: "List files", status: "completed" }],
    });
    expect(summarizeEnvelope(envelope)).toBeNull();
  });

  it("pushEnvelopeToBuffer skips null summaries and appends the rest", () => {
    const buffer = new MessageBuffer();
    pushEnvelopeToBuffer(buffer, createEnvelope("agent", { t: "turn-start" }));
    expect(buffer.getMessages()).toEqual([]);

    pushEnvelopeToBuffer(buffer, createEnvelope("user", { t: "text", md: "hi" }));
    expect(buffer.getMessages()).toHaveLength(1);
    expect(buffer.getMessages()[0]?.content).toBe("You: hi");
  });
});
