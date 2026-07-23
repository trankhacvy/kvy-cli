import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import {
  ASK_FALLBACK_REASON,
  type AskQuestion,
  type CancelableTimer,
  composeAskAnswerReason,
  isAskUserQuestion,
  PERMISSION_MODE_CYCLE,
  type PermissionRequestHookOutput,
  PreToolPermissionBridge,
  type PreToolPermissionBridgeDeps,
  type PreToolUseHookOutput,
  permissionModeCyclePresses,
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
function permissionModeEvents(emitted: SessionEnvelope[]) {
  return emitted.filter((e) => e.ev.t === "permission-mode");
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

describe("PreToolPermissionBridge — onPromptLikely (W1.3)", () => {
  it("fires onPromptLikely from handlePreToolUse on a local turn, not a web turn", async () => {
    const onPromptLikely = vi.fn();
    const local = makeBridge({ isWebTurnActive: () => false, onPromptLikely });
    await local.bridge.handlePreToolUse({ tool_name: "Bash" });
    expect(onPromptLikely).toHaveBeenCalledOnce();

    const web = makeBridge({ isWebTurnActive: () => true, onPromptLikely });
    await web.bridge.handlePreToolUse({ tool_name: "Bash" });
    expect(onPromptLikely).toHaveBeenCalledOnce(); // unchanged — no second call
  });

  it("fires onPromptLikely from handlePermissionRequest's local-undefined return, not the web path", async () => {
    const onPromptLikely = vi.fn();
    const local = makeBridge({ isWebTurnActive: () => false, onPromptLikely });
    await local.bridge.handlePermissionRequest({ tool_name: "Bash" });
    expect(onPromptLikely).toHaveBeenCalledOnce();

    const web = makeBridge({ isWebTurnActive: () => true, onPromptLikely });
    void web.bridge.handlePermissionRequest({ tool_name: "Bash" });
    expect(onPromptLikely).toHaveBeenCalledOnce(); // unchanged
  });
});

describe("PreToolPermissionBridge — onPendingAttention (docs/user-flows.md fix-plan task 4)", () => {
  it("fires 'perm' from handlePermissionRequest on both a local AND a web turn", async () => {
    const onPendingAttention = vi.fn();
    const local = makeBridge({ isWebTurnActive: () => false, onPendingAttention });
    await local.bridge.handlePermissionRequest({ tool_name: "Bash" });
    expect(onPendingAttention).toHaveBeenCalledExactlyOnceWith("perm");

    const web = makeBridge({ isWebTurnActive: () => true, onPendingAttention });
    void web.bridge.handlePermissionRequest({ tool_name: "Bash" });
    expect(onPendingAttention).toHaveBeenCalledTimes(2);
    expect(onPendingAttention).toHaveBeenNthCalledWith(2, "perm");
  });

  it("fires 'question' from the AskUserQuestion PreToolUse path on both a local AND a web turn", async () => {
    const onPendingAttention = vi.fn();
    const local = makeBridge({ isWebTurnActive: () => false, onPendingAttention });
    await local.bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });
    expect(onPendingAttention).toHaveBeenCalledExactlyOnceWith("question");

    const web = makeBridge({ isWebTurnActive: () => true, onPendingAttention });
    void web.bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });
    expect(onPendingAttention).toHaveBeenCalledTimes(2);
    expect(onPendingAttention).toHaveBeenNthCalledWith(2, "question");
  });

  it("never fires from an ordinary handlePreToolUse call (only PermissionRequest/AskUserQuestion count as 'pending')", async () => {
    const onPendingAttention = vi.fn();
    const { bridge } = makeBridge({ onPendingAttention });
    await bridge.handlePreToolUse({ tool_name: "Bash" });
    expect(onPendingAttention).not.toHaveBeenCalled();
  });

  // docs/plan-flows-3-4-5.md FL5.1 "notify-callsite-guard": the assertions
  // above only prove `onPendingAttention` is called *eventually* — they
  // `await` the handler's returned promise first, so they'd pass just as
  // well if the call site were moved to fire only once the decision
  // resolves. These two tests instead assert the call already happened
  // BEFORE the decision is ever made — i.e. before `bridge.resolve()` is
  // called at all — which is the actual property `bridge:651-652`/`:588-589`
  // exist for (push arrives before the tool runs, not merely "at some
  // point"). Deleting or commenting out either call site fails the first
  // expectation in its test (zero calls where one is expected); moving the
  // call into `settle`/after the decision resolves also fails it, since at
  // that point in the test no decision has been supplied yet.
  it("invokes onPendingAttention('perm') from handlePermissionRequest before the decision resolves (guards bridge.ts:651-652)", async () => {
    const onPendingAttention = vi.fn();
    const { bridge, emitted } = makeBridge({ onPendingAttention });
    const pending = bridge.handlePermissionRequest({ tool_name: "Bash" });

    // No decision has been supplied yet — if this passes, the call fired
    // strictly before resolution.
    expect(onPendingAttention).toHaveBeenCalledExactlyOnceWith("perm");

    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "allow", scope: "once" } });
    await pending;

    // Still exactly one call after resolving — the resolve path itself
    // doesn't (and shouldn't) fire it again.
    expect(onPendingAttention).toHaveBeenCalledExactlyOnceWith("perm");
  });

  it("invokes onPendingAttention('question') from the AskUserQuestion path before the decision resolves (guards bridge.ts:588-589)", async () => {
    const onPendingAttention = vi.fn();
    const { bridge, emitted } = makeBridge({ onPendingAttention });
    const pending = bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });

    // No decision has been supplied yet — if this passes, the call fired
    // strictly before resolution.
    expect(onPendingAttention).toHaveBeenCalledExactlyOnceWith("question");

    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };
    bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "deny", message: "no" } });
    await pending;

    expect(onPendingAttention).toHaveBeenCalledExactlyOnceWith("question");
  });
});

describe("PreToolPermissionBridge — handlePermissionRequest — local vs web policy", () => {
  it("returns undefined immediately for a local turn (docs/known-issues.md #5: but still emits a live perm-request for web)", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    const output = await bridge.handlePermissionRequest({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    // The local hand-off is immediate and unaffected — no added latency for
    // the terminal's own TUI dialog.
    expect(output).toBeUndefined();

    // But web must now see a live, actionable card too (issue #5's core fix)
    // instead of a bare "Running" card with no buttons.
    const requests = permRequests(emitted);
    expect(requests).toHaveLength(1);
    const ev = requests[0]?.ev as Extract<SessionEnvelope["ev"], { t: "perm-request" }>;
    expect(ev.name).toBe("Bash");
    expect(ev.args).toEqual({ command: "ls" });

    // Tracked pending (for the local-resolution correlation), not blocking —
    // there's nothing left to await.
    expect(bridge.pendingCount).toBe(1);
  });

  it("a local turn's perm-request resolves via resolveLocalOutcome, not resolve() (no channel to drive the terminal from web)", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    await bridge.handlePermissionRequest({ tool_name: "Bash", tool_input: { command: "ls" } });
    const ev = permRequests(emitted)[0]?.ev as Extract<SessionEnvelope["ev"], { t: "perm-request" }>;

    // A web `perm.answer` racing in gets an honest "can't drive this" answer
    // — not the misleading `already-answered` (nothing has been answered).
    const raced = bridge.resolve({ reqId: ev.reqId, decision: { kind: "allow", scope: "once" } });
    expect(raced).toEqual({ ok: false });
    expect(permResolves(emitted)).toHaveLength(0);
    expect(bridge.pendingCount).toBe(1);

    // The terminal's own resolution (correlated via a matching tool-start/
    // tool-end pair, wired from start.ts) is what actually completes it.
    bridge.resolveLocalOutcome("Bash", "approved");
    const resolves = permResolves(emitted);
    expect(resolves).toHaveLength(1);
    expect((resolves[0]?.ev as { decision: unknown }).decision).toEqual({
      kind: "allow",
      scope: "once",
    });
    expect(bridge.pendingCount).toBe(0);
  });

  it("resolveLocalOutcome('denied', ...) emits a perm-resolve deny", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    await bridge.handlePermissionRequest({ tool_name: "Write" });

    bridge.resolveLocalOutcome("Write", "denied");
    const resolves = permResolves(emitted);
    expect(resolves).toHaveLength(1);
    expect((resolves[0]?.ev as { decision: { kind: string } }).decision.kind).toBe("deny");
    expect(bridge.pendingCount).toBe(0);
  });

  it("resolveLocalOutcome is a no-op for a tool name with nothing pending", () => {
    const { bridge, emitted } = makeBridge();
    bridge.resolveLocalOutcome("Bash", "approved");
    expect(permResolves(emitted)).toHaveLength(0);
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

  it("a locally-typed ExitPlanMode (plan approve/reject) inherits the same live-visibility + local-resolution fix — nothing special-cased for it (docs/known-issues.md #5)", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    const output = await bridge.handlePermissionRequest({
      tool_name: "ExitPlanMode",
      tool_input: { plan: "Do the thing" },
    });

    // Same immediate local hand-off as any other tool — the terminal's own
    // plan approve/reject dialog renders untouched.
    expect(output).toBeUndefined();

    const ev = permRequests(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-request" }
    >;
    expect(ev.name).toBe("ExitPlanMode");
    expect(ev.modes).toEqual(["default", "acceptEdits", "bypassPermissions"]);
    expect(bridge.pendingCount).toBe(1);

    bridge.resolveLocalOutcome("ExitPlanMode", "approved");
    expect(permResolves(emitted)).toHaveLength(1);
    expect(bridge.pendingCount).toBe(0);
  });

  it("does NOT double-track AskUserQuestion — Claude Code fires PermissionRequest as a normal follow-up to PreToolUse's local `ask`, and this must be a no-op, not a second reqId (docs/known-issues.md #5 regression, found verifying track B live)", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });

    // The real sequence for a locally-typed AskUserQuestion: PreToolUse fires
    // first (handled by handleAskUserQuestion, not this method) and creates
    // the one real pending entry; Claude Code's engine then fires
    // PermissionRequest too, since PreToolUse deferred with `ask` rather than
    // denying. Before this fix, that second call independently created its
    // own reqId/pending entry for the exact same logical question.
    const askPending = bridge.handlePreToolUse({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which color?", options: ["Red", "Blue"] }] },
    });
    expect(bridge.pendingCount).toBe(1);

    const permOutput = await bridge.handlePermissionRequest({ tool_name: "AskUserQuestion" });
    expect(permOutput).toBeUndefined();
    // Still exactly one pending entry — the PermissionRequest call must be a
    // pure no-op for this tool, not a second registration.
    expect(bridge.pendingCount).toBe(1);
    // And no second `perm-request` envelope went out for it either.
    expect(permRequests(emitted)).toHaveLength(1);

    // The one real tool-end (the only one that will ever fire, since there's
    // only one real tool call) must resolve the one real pending entry.
    bridge.resolveLocalOutcome("AskUserQuestion", "approved");
    expect(bridge.pendingCount).toBe(0);
    expect(permResolves(emitted)).toHaveLength(1);

    const out = (await askPending) as PreToolUseHookOutput;
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
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

  it("reset() also drains a still-open local-turn request (never resolved locally), emitting a deny perm-resolve", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    await bridge.handlePermissionRequest({ tool_name: "Bash" });
    expect(bridge.pendingCount).toBe(1);

    bridge.reset("session ended");

    const resolves = permResolves(emitted);
    expect(resolves).toHaveLength(1);
    expect((resolves[0]?.ev as { decision: { kind: string } }).decision.kind).toBe("deny");
    expect(bridge.pendingCount).toBe(0);

    // A tool-end arriving after reset() no longer matches anything.
    bridge.resolveLocalOutcome("Bash", "approved");
    expect(permResolves(emitted)).toHaveLength(1);
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

describe("isAskUserQuestion", () => {
  it("matches both tool-name spellings and nothing else", () => {
    expect(isAskUserQuestion("AskUserQuestion")).toBe(true);
    expect(isAskUserQuestion("ask_user_question")).toBe(true);
    expect(isAskUserQuestion("Bash")).toBe(false);
  });
});

describe("composeAskAnswerReason", () => {
  it("formats a single question in Claude Code's own native answer shape (snapshot)", () => {
    const questions: AskQuestion[] = [
      { question: "Which color?", options: ["Red", "Blue", "Green"] },
    ];
    expect(composeAskAnswerReason(questions, { "Which color?": "Blue" })).toBe(
      [
        "The user answered via the Falcon web UI:",
        "- Which color?\n  → Blue",
        "Proceed using these answers. Do not call AskUserQuestion again for these questions.",
      ].join("\n"),
    );
  });

  it("formats multiple questions, each on its own bullet (snapshot)", () => {
    const questions: AskQuestion[] = [
      { question: "Which color?", options: ["Red", "Blue"] },
      { question: "Which size?", options: ["Small", "Large"] },
    ];
    expect(
      composeAskAnswerReason(questions, { "Which color?": "Blue", "Which size?": "Large" }),
    ).toBe(
      [
        "The user answered via the Falcon web UI:",
        "- Which color?\n  → Blue",
        "- Which size?\n  → Large",
        "Proceed using these answers. Do not call AskUserQuestion again for these questions.",
      ].join("\n"),
    );
  });

  it("falls back to `(no answer)` for a question missing from the answers map", () => {
    const questions: AskQuestion[] = [{ question: "Which color?", options: ["Red"] }];
    expect(composeAskAnswerReason(questions, {})).toContain("→ (no answer)");
  });
});

describe("PreToolPermissionBridge — handlePreToolUse — AskUserQuestion special case (W2.1)", () => {
  it("local turn: defers with `ask` pointing at the terminal widget (docs/known-issues.md #5: but still emits a live perm-request for web)", async () => {
    const onPromptLikely = vi.fn();
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false, onPromptLikely });

    const out = await bridge.handlePreToolUse({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which color?", options: ["Red", "Blue"] }] },
    });

    // The local hand-off is immediate and unaffected — the terminal's own
    // question widget still renders with no added delay.
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("terminal");
    expect(onPromptLikely).toHaveBeenCalledOnce();

    // But web must now see the pending question too (issue #5's core fix).
    const requests = permRequests(emitted);
    expect(requests).toHaveLength(1);
    const ev = requests[0]?.ev as Extract<SessionEnvelope["ev"], { t: "perm-request" }>;
    expect(ev.name).toBe("AskUserQuestion");
    expect(ev.modes).toEqual([]);
    expect(bridge.pendingCount).toBe(1);

    // Completed once the terminal's mirrored tool-end correlates it — not by
    // a web `resolve()` call, which has no channel to drive the terminal.
    bridge.resolveLocalOutcome("AskUserQuestion", "approved");
    expect(permResolves(emitted)).toHaveLength(1);
    expect(bridge.pendingCount).toBe(0);
  });

  it("web turn: emits a perm-request with no mode options and blocks for an answer", async () => {
    const { bridge, emitted } = makeBridge();
    const questions = [{ question: "Which color?", options: ["Red", "Blue", "Green"] }];
    const pending = bridge.handlePreToolUse({
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    });

    const reqEv = permRequests(emitted)[0]?.ev as Extract<
      SessionEnvelope["ev"],
      { t: "perm-request" }
    >;
    expect(reqEv.name).toBe("AskUserQuestion");
    expect(reqEv.args).toEqual({ questions });
    expect(reqEv.modes).toEqual([]);
    expect(bridge.pendingCount).toBe(1);

    bridge.resolve({
      reqId: reqEv.reqId,
      decision: {
        kind: "allow",
        scope: "once",
        updatedInput: { answers: { "Which color?": "Blue" } },
      },
    });
    const out = (await pending) as PreToolUseHookOutput;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
      composeAskAnswerReason(questions, { "Which color?": "Blue" }),
    );
    expect(bridge.pendingCount).toBe(0);
  });

  it("web turn, answer decision missing the answers shape: degrades to the plain-text fallback", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which color?", options: ["Red"] }] },
    });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "allow", scope: "once" } });
    const out = (await pending) as PreToolUseHookOutput;

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(ASK_FALLBACK_REASON);
  });

  it("web turn, an allow decision whose updatedInput.answers is not a record: degrades to the plain-text fallback", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which color?", options: ["Red"] }] },
    });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    bridge.resolve({
      reqId: reqEv.reqId,
      decision: { kind: "allow", scope: "once", updatedInput: { answers: "not-a-record" } },
    });
    const out = (await pending) as PreToolUseHookOutput;

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(ASK_FALLBACK_REASON);
  });

  it("web turn, a deny decision: denies with the decision's own message, or the fallback reason", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "ask_user_question" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "deny", message: "not now" } });
    const out = (await pending) as PreToolUseHookOutput;

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("not now");
  });

  it("web turn, a mode-switch decision (nonsensical for a question): degrades to the plain-text fallback", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "mode", mode: "acceptEdits" } });
    const out = (await pending) as PreToolUseHookOutput;

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(ASK_FALLBACK_REASON);
  });

  it("times out to the plain-text fallback reason exactly (no anti-workaround guard appended)", async () => {
    const { bridge, triggerTimeout } = makeBridge({ answerTimeoutMs: 1000 });
    const pending = bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });

    triggerTimeout();
    const out = (await pending) as PreToolUseHookOutput;

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(ASK_FALLBACK_REASON);
    expect(bridge.pendingCount).toBe(0);
  });

  it("is first-wins, sharing the resolve()/reset() plumbing with the `pending` map", async () => {
    const { bridge, emitted } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });
    const reqEv = permRequests(emitted)[0]?.ev as { reqId: string };

    const first = bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "deny", message: "a" } });
    const second = bridge.resolve({ reqId: reqEv.reqId, decision: { kind: "deny", message: "b" } });

    expect(first).toEqual({ ok: true });
    expect(second.ok).toBe(false);
    await pending;
  });

  it("reset() settles a pending question as a guarded deny", async () => {
    const { bridge } = makeBridge();
    const pending = bridge.handlePreToolUse({ tool_name: "AskUserQuestion" });

    bridge.reset("session ended");
    const out = (await pending) as PreToolUseHookOutput;

    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "Do not attempt this action another way.",
    );
    expect(bridge.pendingCount).toBe(0);
  });
});

describe("permissionModeCyclePresses (W4.3 — fixed 4-state Shift+Tab cycle)", () => {
  it("is 0 when already at the target mode", () => {
    for (const mode of PERMISSION_MODE_CYCLE) {
      expect(permissionModeCyclePresses(mode, mode)).toBe(0);
    }
  });

  it("counts forward-only presses around the fixed cycle order", () => {
    expect(permissionModeCyclePresses("default", "acceptEdits")).toBe(1);
    expect(permissionModeCyclePresses("default", "plan")).toBe(2);
    expect(permissionModeCyclePresses("default", "bypassPermissions")).toBe(3);
    // Wraps forward past the end of the cycle rather than going "backward".
    expect(permissionModeCyclePresses("bypassPermissions", "default")).toBe(1);
    expect(permissionModeCyclePresses("plan", "default")).toBe(2);
  });

  it("N presses from any mode returns to that same mode (a full cycle)", () => {
    for (const mode of PERMISSION_MODE_CYCLE) {
      expect(permissionModeCyclePresses(mode, mode) % PERMISSION_MODE_CYCLE.length).toBe(0);
    }
  });
});

describe("PreToolPermissionBridge — permission_mode cache (W4.3)", () => {
  it("starts with no cached mode", () => {
    const { bridge } = makeBridge();
    expect(bridge.currentPermissionMode).toBeNull();
  });

  it("caches permission_mode from handlePreToolUse (both the deferred and the AskUserQuestion path)", async () => {
    const { bridge } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    expect(bridge.currentPermissionMode).toBe("acceptEdits");
  });

  it("caches permission_mode from handlePermissionRequest, on both the local and web path", async () => {
    const local = makeBridge({ isWebTurnActive: () => false });
    await local.bridge.handlePermissionRequest({ tool_name: "Bash", permission_mode: "plan" });
    expect(local.bridge.currentPermissionMode).toBe("plan");

    const web = makeBridge({ isWebTurnActive: () => true });
    const pending = web.bridge.handlePermissionRequest({
      tool_name: "Bash",
      permission_mode: "bypassPermissions",
    });
    expect(web.bridge.currentPermissionMode).toBe("bypassPermissions");
    web.bridge.reset(); // settle the still-pending web request so the test doesn't hang
    await pending;
  });

  it("ignores an unrecognized permission_mode value instead of corrupting the cache", async () => {
    const { bridge } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "some-future-mode" });
    expect(bridge.currentPermissionMode).toBe("acceptEdits");
  });

  it("leaves the cache untouched when a hook input omits permission_mode entirely", async () => {
    const { bridge } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "plan" });
    await bridge.handlePreToolUse({ tool_name: "Bash" });
    expect(bridge.currentPermissionMode).toBe("plan");
  });
});

describe("PreToolPermissionBridge — initialPermissionMode seed (docs/bug-fix-plan.md #5 fix)", () => {
  it("reports the seeded mode via currentPermissionMode before any hook has fired", () => {
    const { bridge } = makeBridge({ initialPermissionMode: "default" });
    expect(bridge.currentPermissionMode).toBe("default");
  });

  it("emits on the very first hook call when it's a genuine transition from the seeded baseline — the exact gap this fix closes: a Shift+Tab before ever using a tool", async () => {
    const { bridge, emitted } = makeBridge({ initialPermissionMode: "default" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "plan" });
    const events = permissionModeEvents(emitted);
    expect(events).toHaveLength(1);
    expect(events[0]?.ev).toEqual({ t: "permission-mode", mode: "plan", source: "terminal" });
  });

  it("does not emit on the first hook call when it merely echoes the seeded baseline unchanged", async () => {
    const { bridge, emitted } = makeBridge({ initialPermissionMode: "default" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "default" });
    expect(permissionModeEvents(emitted)).toHaveLength(0);
  });

  it("without a seed (the pre-fix default), the first observed mode still stays silent", async () => {
    const { bridge, emitted } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "plan" });
    expect(permissionModeEvents(emitted)).toHaveLength(0);
  });
});

describe("PreToolPermissionBridge — emits permission-mode on a genuine transition (docs/bug-fix-plan.md §5)", () => {
  it("does not emit on the very first observed mode (announcing a baseline, not a change)", async () => {
    const { bridge, emitted } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    expect(permissionModeEvents(emitted)).toHaveLength(0);
  });

  it("emits exactly one permission-mode event on the second call, when the mode actually changed", async () => {
    const { bridge, emitted } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "default" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    const events = permissionModeEvents(emitted);
    expect(events).toHaveLength(1);
    expect(events[0]?.ev).toEqual({
      t: "permission-mode",
      mode: "acceptEdits",
      source: "terminal",
    });
  });

  it("does not emit again on a repeated echo of the same mode", async () => {
    const { bridge, emitted } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "default" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    expect(permissionModeEvents(emitted)).toHaveLength(1);
  });

  it("ignores an unrecognized permission_mode value — no emit, no cache corruption", async () => {
    const { bridge, emitted } = makeBridge();
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "default" });
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "some-future-mode" });
    expect(permissionModeEvents(emitted)).toHaveLength(0);
    expect(bridge.currentPermissionMode).toBe("default");
  });

  it("emits from handlePermissionRequest too, on a genuine transition", async () => {
    const { bridge, emitted } = makeBridge({ isWebTurnActive: () => false });
    await bridge.handlePermissionRequest({ tool_name: "Bash", permission_mode: "default" });
    await bridge.handlePermissionRequest({ tool_name: "Bash", permission_mode: "plan" });
    const events = permissionModeEvents(emitted);
    expect(events).toHaveLength(1);
    expect(events[0]?.ev).toEqual({ t: "permission-mode", mode: "plan", source: "terminal" });
  });
});

describe("PreToolPermissionBridge — waitForModeEcho (W4.3 verify-via-hook-echo)", () => {
  it("resolves with the mode observed on the very next hook input", async () => {
    const { bridge } = makeBridge();
    const echo = bridge.waitForModeEcho(5000);
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "acceptEdits" });
    await expect(echo).resolves.toBe("acceptEdits");
  });

  it("resolves null on timeout when no hook input arrives in time", async () => {
    const { bridge, triggerTimeout } = makeBridge();
    const echo = bridge.waitForModeEcho(5000);
    triggerTimeout();
    await expect(echo).resolves.toBeNull();
  });

  it("only settles once — a late hook input after timeout doesn't re-resolve, and a late timeout after resolution doesn't override it", async () => {
    const { bridge, triggerTimeout } = makeBridge();
    const echo = bridge.waitForModeEcho(5000);
    await bridge.handlePreToolUse({ tool_name: "Bash", permission_mode: "plan" });
    triggerTimeout(); // fires after the watcher already settled — must be a no-op
    await expect(echo).resolves.toBe("plan");
  });
});
