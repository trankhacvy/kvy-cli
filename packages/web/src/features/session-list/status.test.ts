import { createEnvelope } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { reduceEnvelopes } from "@/sync/reducer";
import { deriveSessionStatus } from "./status";

const base = { status: "active" as const, machineOnline: true, attention: null };

describe("deriveSessionStatus", () => {
  it("is idle for a session with no messages yet", () => {
    expect(deriveSessionStatus({ ...base, items: [] })).toBe("idle");
  });

  it("is working while a turn is open with nothing blocking it", () => {
    const items = reduceEnvelopes([createEnvelope("user", { t: "turn-start" }, { time: 1 })]);
    expect(deriveSessionStatus({ ...base, items })).toBe("working");
  });

  it("is idle once the turn ends cleanly", () => {
    const items = reduceEnvelopes([
      createEnvelope("user", { t: "turn-start" }, { time: 1 }),
      createEnvelope("agent", { t: "turn-end", status: "completed" }, { time: 2 }),
    ]);
    expect(deriveSessionStatus({ ...base, items })).toBe("idle");
  });

  it("is waiting-for-permission when a tool-linked permission has no decision yet", () => {
    const items = reduceEnvelopes([
      createEnvelope("user", { t: "turn-start" }, { time: 1 }),
      createEnvelope(
        "agent",
        { t: "perm-request", reqId: "r1", call: "c1", name: "Bash", args: {}, modes: ["default"] },
        { time: 2 },
      ),
      createEnvelope(
        "agent",
        { t: "tool-start", call: "c1", name: "Bash", args: { command: "rm -rf x" } },
        { time: 3 },
      ),
    ]);
    expect(deriveSessionStatus({ ...base, items })).toBe("waiting-for-permission");
  });

  it("stops waiting-for-permission once the request resolves", () => {
    const items = reduceEnvelopes([
      createEnvelope("user", { t: "turn-start" }, { time: 1 }),
      createEnvelope(
        "agent",
        { t: "perm-request", reqId: "r1", call: "c1", name: "Bash", args: {}, modes: ["default"] },
        { time: 2 },
      ),
      createEnvelope(
        "agent",
        { t: "tool-start", call: "c1", name: "Bash", args: { command: "rm -rf x" } },
        { time: 3 },
      ),
      createEnvelope(
        "agent",
        { t: "perm-resolve", reqId: "r1", decision: { kind: "allow", scope: "once" } },
        { time: 4 },
      ),
    ]);
    expect(deriveSessionStatus({ ...base, items })).toBe("working");
  });

  it("finds a pending permission nested under a subagent", () => {
    const items = reduceEnvelopes([
      createEnvelope("user", { t: "turn-start" }, { time: 1 }),
      createEnvelope(
        "agent",
        { t: "tool-start", call: "task1", name: "Task", args: {} },
        { time: 2 },
      ),
      createEnvelope("agent", { t: "sub-start" }, { time: 3, subagent: "task1" }),
      createEnvelope(
        "agent",
        { t: "perm-request", reqId: "r1", call: "c1", name: "Write", args: {}, modes: ["default"] },
        { time: 4, subagent: "task1" },
      ),
      createEnvelope(
        "agent",
        { t: "tool-start", call: "c1", name: "Write", args: {} },
        { time: 5, subagent: "task1" },
      ),
    ]);
    expect(deriveSessionStatus({ ...base, items })).toBe("waiting-for-permission");
  });

  it("finds a pending permission in a subagent scope that never linked to a parent tool call", () => {
    const items = reduceEnvelopes([
      createEnvelope("user", { t: "turn-start" }, { time: 1 }),
      createEnvelope("agent", { t: "sub-start" }, { time: 2, subagent: "orphan-subagent" }),
      createEnvelope(
        "agent",
        { t: "perm-request", reqId: "r1", name: "Write", args: {}, modes: ["default"] },
        { time: 3, subagent: "orphan-subagent" },
      ),
    ]);
    expect(deriveSessionStatus({ ...base, items })).toBe("waiting-for-permission");
  });

  it("is waiting-for-input when the attention signal says a question is outstanding", () => {
    expect(deriveSessionStatus({ ...base, items: [], attention: "question" })).toBe(
      "waiting-for-input",
    );
  });

  it("is completed when the attention signal says the last turn finished unseen", () => {
    expect(deriveSessionStatus({ ...base, items: [], attention: "done" })).toBe("completed");
  });

  it("is failed when the attention signal flags a turn-level failure", () => {
    expect(deriveSessionStatus({ ...base, items: [], attention: "failed" })).toBe("failed");
  });

  it("is offline when the owning machine is offline, even mid-turn", () => {
    const items = reduceEnvelopes([createEnvelope("user", { t: "turn-start" }, { time: 1 })]);
    expect(deriveSessionStatus({ ...base, items, machineOnline: false })).toBe("offline");
  });

  it("ignores machine presence when the session isn't tied to a machine", () => {
    expect(deriveSessionStatus({ ...base, items: [], machineOnline: null })).toBe("idle");
  });

  it("is failed for a session row already marked failed, regardless of live signals", () => {
    expect(
      deriveSessionStatus({ ...base, status: "failed", attention: "question", items: [] }),
    ).toBe("failed");
  });

  it("is completed for an archived or compacted session row", () => {
    expect(deriveSessionStatus({ ...base, status: "archived", items: [] })).toBe("completed");
    expect(deriveSessionStatus({ ...base, status: "compacted", items: [] })).toBe("completed");
  });

  it("prioritizes offline over a pending permission (nothing can act on the answer while the machine is down)", () => {
    const items = reduceEnvelopes([
      createEnvelope(
        "agent",
        { t: "perm-request", reqId: "r1", name: "Bash", args: {}, modes: ["default"] },
        { time: 1 },
      ),
    ]);
    expect(deriveSessionStatus({ ...base, items, machineOnline: false })).toBe("offline");
  });
});
