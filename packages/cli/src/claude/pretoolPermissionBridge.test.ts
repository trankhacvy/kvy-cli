import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import {
  type CancelableTimer,
  type PermissionRequestHookOutput,
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

describe("PreToolPermissionBridge — handlePreToolUse (W1.1: always defers)", () => {
  it("always returns `ask` and emits nothing, regardless of web-turn state", async () => {
    for (const isWebTurnActive of [() => true, () => false]) {
      const { bridge, emitted } = makeBridge({ isWebTurnActive });
      const output = await bridge.handlePreToolUse({
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });

      expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
      expect(output.suppressOutput).toBe(true);
      expect(emitted).toHaveLength(0);
      expect(bridge.pendingCount).toBe(0);
    }
  });
});

describe("PreToolPermissionBridge — handlePermissionRequest — local vs web policy", () => {
  it("returns undefined immediately for a local turn and emits nothing", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    const output = await bridge.handlePermissionRequest({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    expect(output).toBeUndefined();
    expect(emitted).toHaveLength(0);
    expect(bridge.pendingCount).toBe(0);
  });

  it("emits a perm-request for a web turn and blocks until resolved", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePermissionRequest({
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

    const output = (await pending) as PermissionRequestHookOutput;
    expect(output.hookSpecificOutput.decision?.behavior).toBe("allow");
    expect(permResolves(emitted)).toHaveLength(1);
    expect(bridge.pendingCount).toBe(0);
  });

  it("omits `plan` from the offered modes for ExitPlanMode", async () => {
    const { bridge, emitted } = makeBridge();
    void bridge.handlePermissionRequest({ tool_name: "ExitPlanMode" });
    const ev = permRequests(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-request" }
    >;
    expect(ev.modes).toEqual(["default", "acceptEdits", "bypassPermissions"]);
  });
});

describe("PreToolPermissionBridge — handlePermissionRequest — decision mapping", () => {
  it("maps a deny decision to behavior `deny`, appending the anti-workaround guard", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePermissionRequest({ tool_name: "Write" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    bridge.resolve({ reqId, decision: { kind: "deny", message: "nope" } });
    const output = (await pending) as PermissionRequestHookOutput;

    expect(output.hookSpecificOutput.decision?.behavior).toBe("deny");
    expect(output.hookSpecificOutput.decision?.message).toContain("nope");
    expect(output.hookSpecificOutput.decision?.message).toContain(
      "Do not attempt this action another way.",
    );
  });

  it("appends the anti-workaround guard even to the default deny message", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePermissionRequest({ tool_name: "Write" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "deny" } });
    const output = (await pending) as PermissionRequestHookOutput;

    expect(output.hookSpecificOutput.decision?.message).toContain(
      "Do not attempt this action another way.",
    );
  });

  it("maps a mode decision to `allow` and fires onModeChange", async () => {
    const onModeChange = vi.fn();
    const { bridge, emitted } = makeBridge({ onModeChange });
    const pending = bridge.handlePermissionRequest({ tool_name: "Edit" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    bridge.resolve({ reqId, decision: { kind: "mode", mode: "acceptEdits" } });
    const output = (await pending) as PermissionRequestHookOutput;

    expect(output.hookSpecificOutput.decision?.behavior).toBe("allow");
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("acceptEdits");
  });

  it("allows even when a decision carries updatedInput", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    bridge.resolve({
      reqId,
      decision: { kind: "allow", scope: "session", updatedInput: { command: "safe" } },
    });
    const output = (await pending) as PermissionRequestHookOutput;
    expect(output.hookSpecificOutput.decision?.behavior).toBe("allow");
  });

  it("warns (rather than silently dropping) when an allow decision carries updatedInput", async () => {
    const logger = { warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const { bridge, emitted } = makeBridge({ logger: logger as never });
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    bridge.resolve({
      reqId: reqEv.reqId,
      decision: { kind: "allow", scope: "once", updatedInput: { command: "safe" } },
    });
    await pending;

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("updatedInput is not applied"),
      expect.objectContaining({ toolName: "Bash" }),
    );
  });
});

describe("PreToolPermissionBridge — handlePermissionRequest — first-wins, timeout, reset", () => {
  it("is first-wins: the second resolve reports already-answered with the winning decision", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });
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

  it("denies on timeout, emitting a perm-resolve deny with the anti-workaround guard", async () => {
    const { bridge, emitted, triggerTimeout } = makeBridge({ answerTimeoutMs: 1000 });
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });

    triggerTimeout();
    const output = (await pending) as PermissionRequestHookOutput;

    expect(output.hookSpecificOutput.decision?.behavior).toBe("deny");
    expect(output.hookSpecificOutput.decision?.message).toContain("No response");
    expect(output.hookSpecificOutput.decision?.message).toContain(
      "Do not attempt this action another way.",
    );
    const resolve = permResolves(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-resolve" }
    >;
    expect(resolve.decision.kind).toBe("deny");
    expect(bridge.pendingCount).toBe(0);
  });

  it("a late resolve after timeout reports already-answered", async () => {
    const { bridge, emitted, triggerTimeout } = makeBridge({ answerTimeoutMs: 1000 });
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    const reqId = reqEv.reqId;

    triggerTimeout();
    await pending;

    const late = bridge.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(late.ok).toBe(false);
  });

  it("reset() settles every in-flight request as a deny carrying the anti-workaround guard", async () => {
    const { bridge } = makeBridge();
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });

    bridge.reset("bye");
    const output = (await pending) as PermissionRequestHookOutput;
    expect(output.hookSpecificOutput.decision?.behavior).toBe("deny");
    expect(output.hookSpecificOutput.decision?.message).toContain(
      "Do not attempt this action another way.",
    );
    expect(bridge.pendingCount).toBe(0);
  });

  it("reports agent state snapshots as requests move to completed", async () => {
    const onAgentStateChange = vi.fn();
    const { bridge, emitted } = makeBridge({ onAgentStateChange });
    const pending = bridge.handlePermissionRequest({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
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

describe("PreToolPermissionBridge — resolve()/reset() share both pending maps", () => {
  it("resolve() reports already-answered for a reqId in neither map", () => {
    const { bridge } = makeBridge();
    const result = bridge.resolve({ reqId: "never-existed", decision: { kind: "deny" } });
    expect(result).toEqual({ ok: false, reason: "already-answered" });
  });

  it("reset() is a no-op when nothing is pending", () => {
    const { bridge } = makeBridge();
    expect(() => bridge.reset()).not.toThrow();
    expect(bridge.pendingCount).toBe(0);
  });

  it("pendingCount reflects the permRequestPending map populated by handlePermissionRequest", () => {
    const { bridge } = makeBridge();
    void bridge.handlePermissionRequest({ tool_name: "Bash" });
    void bridge.handlePermissionRequest({ tool_name: "Write" });
    expect(bridge.pendingCount).toBe(2);
  });

  it("reset() settles EVERY in-flight permRequestPending entry, not just the first", async () => {
    const { bridge, emitted } = makeBridge();
    const first = bridge.handlePermissionRequest({ tool_name: "Bash" });
    const second = bridge.handlePermissionRequest({ tool_name: "Write" });
    const third = bridge.handlePermissionRequest({ tool_name: "Edit" });
    expect(bridge.pendingCount).toBe(3);

    bridge.reset("shutting down");

    const [outA, outB, outC] = (await Promise.all([first, second, third])) as (
      | PermissionRequestHookOutput
      | undefined
    )[];
    for (const out of [outA, outB, outC]) {
      expect(out?.hookSpecificOutput.decision?.behavior).toBe("deny");
      expect(out?.hookSpecificOutput.decision?.message).toContain(
        "Do not attempt this action another way.",
      );
    }
    expect(bridge.pendingCount).toBe(0);
    expect(permResolves(emitted)).toHaveLength(3);
  });

  it("resolving one pending request leaves the others still pending", async () => {
    const { bridge, emitted } = makeBridge();
    const first = bridge.handlePermissionRequest({ tool_name: "Bash" });
    const second = bridge.handlePermissionRequest({ tool_name: "Write" });
    const requests = permRequests(emitted);
    const firstReqEv = requests[0]?.ev as { reqId: string };
    const firstReqId = firstReqEv.reqId;

    const result = bridge.resolve({
      reqId: firstReqId,
      decision: { kind: "allow", scope: "once" },
    });
    expect(result).toEqual({ ok: true });
    expect(bridge.pendingCount).toBe(1);

    const firstOutput = (await first) as PermissionRequestHookOutput;
    expect(firstOutput.hookSpecificOutput.decision?.behavior).toBe("allow");

    // The second request is untouched by the first's resolution.
    const secondReqEv = requests[1]?.ev as { reqId: string };
    const secondReqId = secondReqEv.reqId;
    bridge.resolve({ reqId: secondReqId, decision: { kind: "deny" } });
    const secondOutput = (await second) as PermissionRequestHookOutput;
    expect(secondOutput.hookSpecificOutput.decision?.behavior).toBe("deny");
    expect(bridge.pendingCount).toBe(0);
  });
});

describe("PreToolPermissionBridge — handlePermissionRequest — missing tool_input", () => {
  it("defaults tool_input to {} in the emitted perm-request when the hook omits it entirely", async () => {
    const { bridge, emitted } = makeBridge();
    void bridge.handlePermissionRequest({ tool_name: "Bash" });
    const ev = permRequests(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-request" }
    >;
    expect(ev.args).toEqual({});
  });
});
