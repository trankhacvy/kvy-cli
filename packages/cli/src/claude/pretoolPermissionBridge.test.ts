import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import {
  type CancelableTimer,
  PreToolPermissionBridge,
  type PreToolPermissionBridgeDeps,
} from "./pretoolPermissionBridge.js";

/** Collects emitted envelopes + gives a manual timer trigger for the timeout path. */
function makeBridge(overrides: Partial<PreToolPermissionBridgeDeps> = {}) {
  const emitted: SessionEnvelope[] = [];
  let fireTimeout: (() => void) | null = null;
  const setTimer = (callback: () => void): CancelableTimer => {
    fireTimeout = callback;
    return { clear: () => {} };
  };

  const bridge = new PreToolPermissionBridge({
    emitEnvelope: (envelope) => emitted.push(envelope),
    isWebTurnActive: () => true,
    setTimer,
    ...overrides,
  });

  return { bridge, emitted, triggerTimeout: () => fireTimeout?.() };
}

function permRequests(emitted: SessionEnvelope[]) {
  return emitted.filter((e) => e.ev.t === "perm-request");
}
function permResolves(emitted: SessionEnvelope[]) {
  return emitted.filter((e) => e.ev.t === "perm-resolve");
}

describe("PreToolPermissionBridge — local vs web policy", () => {
  it("returns `ask` immediately for a local turn and emits nothing", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    const output = await bridge.handlePreToolUse({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(output.suppressOutput).toBe(true);
    expect(emitted).toHaveLength(0);
    expect(bridge.pendingCount).toBe(0);
  });

  it("emits a perm-request for a web turn and blocks until resolved", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({
      tool_name: "Bash",
      tool_input: { command: "rm -rf x" },
    });

    const requests = permRequests(emitted);
    expect(requests).toHaveLength(1);
    const ev = requests[0]?.ev as Extract<SessionEnvelope["ev"], { t: "perm-request" }>;
    expect(ev.name).toBe("Bash");
    expect(ev.args).toEqual({ command: "rm -rf x" });
    expect(ev.modes).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(bridge.pendingCount).toBe(1);

    const result = bridge.resolve({ reqId: ev.reqId, decision: { kind: "allow", scope: "once" } });
    expect(result).toEqual({ ok: true });

    const output = await pending;
    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(permResolves(emitted)).toHaveLength(1);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe("PreToolPermissionBridge — decision mapping", () => {
  it("maps a deny decision to permissionDecision `deny` carrying the message", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "Write" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    bridge.resolve({ reqId, decision: { kind: "deny", message: "nope" } });
    const output = await pending;

    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("nope");
  });

  it("maps a mode decision to `allow` and fires onModeChange", async () => {
    const onModeChange = vi.fn();
    const { bridge, emitted } = makeBridge({ onModeChange });
    const pending = bridge.handlePreToolUse({ tool_name: "Edit" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    bridge.resolve({ reqId, decision: { kind: "mode", mode: "acceptEdits" } });
    const output = await pending;

    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("acceptEdits");
  });

  it("allows (with the original input) even when a decision carries updatedInput", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "Bash" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    bridge.resolve({
      reqId,
      decision: { kind: "allow", scope: "session", updatedInput: { command: "safe" } },
    });
    const output = await pending;
    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("omits `plan` from the offered modes for ExitPlanMode", async () => {
    const { bridge, emitted } = makeBridge();
    void bridge.handlePreToolUse({ tool_name: "ExitPlanMode" });
    const ev = permRequests(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-request" }
    >;
    expect(ev.modes).toEqual(["default", "acceptEdits", "bypassPermissions"]);
  });
});

describe("PreToolPermissionBridge — first-wins, timeout, reset", () => {
  it("is first-wins: the second resolve reports already-answered with the winning decision", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "Bash" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    const first = bridge.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    const second = bridge.resolve({ reqId, decision: { kind: "deny" } });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      ok: false,
      reason: "already-answered",
      decision: { kind: "allow", scope: "once" },
    });
    await pending;
  });

  it("denies on timeout, emitting a perm-resolve deny", async () => {
    const { bridge, emitted, triggerTimeout } = makeBridge({ answerTimeoutMs: 1000 });
    const pending = bridge.handlePreToolUse({ tool_name: "Bash" });

    triggerTimeout();
    const output = await pending;

    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain("No response");
    const resolve = permResolves(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-resolve" }
    >;
    expect(resolve.decision.kind).toBe("deny");
    expect(bridge.pendingCount).toBe(0);
  });

  it("a late resolve after timeout reports already-answered", async () => {
    const { bridge, emitted, triggerTimeout } = makeBridge({ answerTimeoutMs: 1000 });
    const pending = bridge.handlePreToolUse({ tool_name: "Bash" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    triggerTimeout();
    await pending;

    const late = bridge.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(late.ok).toBe(false);
  });

  it("reset() settles every in-flight request as a deny", async () => {
    const { bridge } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "Bash" });

    bridge.reset("bye");
    const output = await pending;
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(bridge.pendingCount).toBe(0);
  });

  it("reports agent state snapshots as requests move to completed", async () => {
    const onAgentStateChange = vi.fn();
    const { bridge, emitted } = makeBridge({ onAgentStateChange });
    const pending = bridge.handlePreToolUse({ tool_name: "Bash", tool_input: { command: "ls" } });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    // First snapshot: one pending request.
    const firstSnapshot = onAgentStateChange.mock.calls.at(0)?.[0];
    expect(Object.keys(firstSnapshot.requests)).toEqual([reqId]);

    bridge.resolve({ reqId, decision: { kind: "deny" } });
    await pending;

    const lastSnapshot = onAgentStateChange.mock.calls.at(-1)?.[0];
    expect(Object.keys(lastSnapshot.requests)).toHaveLength(0);
    expect(lastSnapshot.completedRequests[reqId]?.status).toBe("denied");
  });
});
