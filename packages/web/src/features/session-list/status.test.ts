import { createEnvelope } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import { reduceEnvelopes } from "@/sync/reducer";
import { deriveSessionStatus } from "./status";

const base = { status: "active" as const, machineOnline: true, attention: null };

describe("deriveSessionStatus", () => {
  it("is ready for a session with no turns yet", () => {
    expect(deriveSessionStatus({ ...base, items: [] })).toBe("ready");
  });

  it("is idle (NOT ready) while items is null — message page not decrypted yet, not confirmed empty", () => {
    // A session with real history that just hasn't decrypted this pass must
    // not flash "ready" — see `SessionListSession.items`'s doc comment and
    // live-source.test.ts's "degrades honestly to idle" fixture for the
    // regression this specifically guards.
    expect(deriveSessionStatus({ ...base, items: null })).toBe("idle");
  });

  it("is working (not ready) while a turn is open, even on a session's very first turn — isTurnOpen is checked before the ready/idle fallback", () => {
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

  it("stays idle (not ready) for a session with real turn history that's since gone quiet", () => {
    const items = reduceEnvelopes([
      createEnvelope("user", { t: "turn-start" }, { time: 1 }),
      createEnvelope("agent", { t: "turn-end", status: "completed" }, { time: 2 }),
      createEnvelope("user", { t: "turn-start" }, { time: 3 }),
      createEnvelope("agent", { t: "turn-end", status: "completed" }, { time: 4 }),
      createEnvelope("user", { t: "turn-start" }, { time: 5 }),
      createEnvelope("agent", { t: "turn-end", status: "completed" }, { time: 6 }),
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
    expect(deriveSessionStatus({ ...base, items: [], machineOnline: null })).toBe("ready");
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

  it("is ended for a session row the CLI reported as ended, regardless of live signals", () => {
    expect(
      deriveSessionStatus({ ...base, status: "ended", attention: "question", items: [] }),
    ).toBe("ended");
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
