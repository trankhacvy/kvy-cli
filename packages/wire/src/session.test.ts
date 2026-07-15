import { isCuid } from "@paralleldrive/cuid2";
import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  SessionEnvelopeSchema,
  type SessionEvent,
  SessionEventSchema,
} from "./session";

describe("SessionEventSchema", () => {
  it("accepts all 12 event variants", () => {
    const events: SessionEvent[] = [
      { t: "text", md: "hello" },
      { t: "text", md: "thinking...", thinking: true },
      { t: "service", text: "restarting MCP bridge" },
      { t: "tool-start", call: "call-1", name: "Bash", args: { command: "ls" }, risk: "exec" },
      { t: "tool-start", call: "call-2", name: "Read", title: "Read file", args: {} },
      { t: "tool-end", call: "call-1", ok: true, output: { stdout: "" } },
      { t: "file", ref: "upload-1", name: "report.txt", size: 1024 },
      {
        t: "file",
        ref: "upload-2",
        name: "image.png",
        size: 2048,
        image: { w: 100, h: 80, thumbhash: "abc" },
      },
      { t: "turn-start" },
      { t: "turn-end", status: "completed" },
      { t: "perm-request", reqId: "req-1", name: "Bash", args: {}, modes: ["default", "plan"] },
      { t: "perm-resolve", reqId: "req-1", decision: { kind: "allow", scope: "once" } },
      { t: "mode-switch", control: "remote", by: "client" },
      { t: "sub-start" },
      { t: "sub-stop" },
    ];

    for (const event of events) {
      const result = SessionEventSchema.safeParse(event);
      expect(
        result.success,
        `expected ${event.t} to parse: ${JSON.stringify(result.success ? null : result.error)}`,
      ).toBe(true);
    }
  });

  it("rejects malformed events", () => {
    expect(SessionEventSchema.safeParse({ t: "tool-start", call: "1" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ t: "turn-end", status: "canceled" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ t: "file", ref: "x", name: "x" }).success).toBe(false);
    expect(SessionEventSchema.safeParse({ t: "not-a-real-type" }).success).toBe(false);
  });
});

describe("SessionEnvelopeSchema", () => {
  it("accepts a minimal envelope and one with turn/subagent", () => {
    const minimal = { id: "msg-1", time: 1234, role: "agent", ev: { t: "turn-start" } };
    expect(SessionEnvelopeSchema.safeParse(minimal).success).toBe(true);

    const withScope = {
      id: "msg-2",
      time: 1234,
      role: "agent",
      turn: "turn-1",
      subagent: "sub-1",
      ev: { t: "text", md: "hi" },
    };
    expect(SessionEnvelopeSchema.safeParse(withScope).success).toBe(true);
  });

  it("rejects an unknown role", () => {
    const bad = { id: "msg-3", time: 1, role: "session", ev: { t: "turn-start" } };
    expect(SessionEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("createEnvelope", () => {
  it("mints a cuid2 id and current time by default", () => {
    const envelope = createEnvelope("agent", { t: "turn-start" });
    expect(isCuid(envelope.id)).toBe(true);
    expect(typeof envelope.time).toBe("number");
    expect(envelope.role).toBe("agent");
  });

  it("respects explicit options", () => {
    const envelope = createEnvelope(
      "user",
      { t: "text", md: "hi" },
      { id: "fixed-id", time: 42, turn: "turn-1", subagent: "sub-1" },
    );
    expect(envelope).toEqual({
      id: "fixed-id",
      time: 42,
      role: "user",
      turn: "turn-1",
      subagent: "sub-1",
      ev: { t: "text", md: "hi" },
    });
  });

  it("throws on an invalid event rather than minting a broken envelope", () => {
    expect(() => createEnvelope("agent", { t: "turn-end", status: "canceled" } as never)).toThrow();
  });
});
