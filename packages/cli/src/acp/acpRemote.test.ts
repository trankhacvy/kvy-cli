import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type {
  ReportSessionAttentionDeps,
  reportSessionAttention as reportSessionAttentionDefault,
} from "../api/sessionNotify.js";
import { AcpConnectionError, type PermissionRequestHandler } from "./acpConnection.js";
import type { AcpRemoteConnection, AcpRemoteHandle } from "./acpRemote.js";
import { startAcpRemote } from "./acpRemote.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type PromptCall = {
  sessionId: string;
  text: string;
  resolve: (result: { stopReason: string }) => void;
  reject: (error: Error) => void;
};

/** Scripted fake — prompts stay pending until the test settles them. */
class FakeConnection implements AcpRemoteConnection {
  connectCalls = 0;
  createdMeta: Record<string, unknown> | null | undefined;
  prompts: PromptCall[] = [];
  cancelled: string[] = [];
  modeCalls: { sessionId: string; modeId: string }[] = [];
  loadSessionCalls: { sessionId: string; cwd: string }[] = [];
  disconnected = false;
  permissionHandler?: PermissionRequestHandler;
  sessionId = "uuid-session-1";
  failConnect?: Error;
  sessionLoadSupported = false;
  failLoadSession?: Error;

  private updateListeners = new Set<(n: { update: unknown }) => void>();
  private errorListeners = new Set<(e: AcpConnectionError) => void>();

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failConnect) throw this.failConnect;
  }

  async createSession(options: {
    cwd: string;
    meta?: Record<string, unknown> | null;
  }): Promise<{ sessionId: string }> {
    this.createdMeta = options.meta;
    return { sessionId: this.sessionId };
  }

  prompt(
    sessionId: string,
    prompt: { type: "text"; text: string }[],
  ): Promise<{
    stopReason: string;
  }> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ sessionId, text: prompt[0]?.text ?? "", resolve, reject });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.modeCalls.push({ sessionId, modeId });
  }

  supportsSessionLoad(): boolean {
    return this.sessionLoadSupported;
  }

  async loadSession(sessionId: string, cwd: string): Promise<unknown> {
    if (this.failLoadSession) throw this.failLoadSession;
    this.loadSessionCalls.push({ sessionId, cwd });
    return {};
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  onSessionUpdate(listener: (n: { update: unknown }) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onError(listener: (e: AcpConnectionError) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  setPermissionHandler(handler: PermissionRequestHandler | undefined): void {
    this.permissionHandler = handler;
  }

  emitUpdate(update: unknown): void {
    for (const l of this.updateListeners) l({ update });
  }

  emitError(message: string): void {
    for (const l of this.errorListeners) l(new AcpConnectionError(message));
  }
}

interface Harness {
  handle: AcpRemoteHandle;
  connection: FakeConnection;
  envelopes: SessionEnvelope[];
  settled: { messageId?: string; status: string }[];
  providerIds: string[];
}

function harness(
  opts: {
    adapterId?: "claude-code" | "codex";
    resume?: string;
    model?: string;
    failConnect?: Error;
    sessionId?: string;
    attention?: ReportSessionAttentionDeps;
    reportSessionAttention?: typeof reportSessionAttentionDefault;
  } = {},
): Harness {
  const connection = new FakeConnection();
  if (opts.failConnect) connection.failConnect = opts.failConnect;
  const envelopes: SessionEnvelope[] = [];
  const settled: { messageId?: string; status: string }[] = [];
  const providerIds: string[] = [];
  const handle = startAcpRemote(
    {
      adapterId: opts.adapterId,
      workingDirectory: "/tmp/ws",
      resume: opts.resume,
      model: opts.model,
      permissionMode: "default",
      homeDir: "/tmp/falcon-home",
      sessionId: opts.sessionId,
      attention: opts.attention,
      onEnvelopes: (batch) => envelopes.push(...batch),
      onProviderSessionId: (id) => providerIds.push(id),
      onTurnSettled: (info) => settled.push(info),
    },
    { createConnection: () => connection, reportSessionAttention: opts.reportSessionAttention },
  );
  return { handle, connection, envelopes, settled, providerIds };
}

function eventTypes(envelopes: SessionEnvelope[]): string[] {
  return envelopes.map((e) => e.ev.t);
}

describe("session startup", () => {
  it("creates the ACP session with the Claude meta payload and reports the provider session id", async () => {
    const h = harness({ resume: "prior-uuid", model: "claude-x" });
    h.handle.send("hi");
    await flushMicrotasks();

    expect(h.connection.connectCalls).toBe(1);
    expect(h.connection.createdMeta).toEqual({
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: expect.stringContaining("Falcon"),
      },
      claudeCode: {
        options: { resume: "prior-uuid", model: "claude-x", permissionMode: "default" },
      },
    });
    expect(h.providerIds).toEqual(["uuid-session-1"]);
  });

  it("uses session/new (createSession), not session/load, when the adapter doesn't advertise loadSession support — matches prior behavior for every provider that never gained resume support", async () => {
    const h = harness({ resume: "prior-uuid" });
    h.handle.send("hi");
    await flushMicrotasks();

    expect(h.connection.loadSessionCalls).toEqual([]);
    expect(h.providerIds).toEqual(["uuid-session-1"]);
  });

  it("resumes via session/load when the adapter advertises loadSession support and a resume id was given", async () => {
    const h = harness({ adapterId: "codex", resume: "prior-uuid" });
    h.connection.sessionLoadSupported = true;
    h.handle.send("hi");
    await flushMicrotasks();

    expect(h.connection.loadSessionCalls).toEqual([{ sessionId: "prior-uuid", cwd: "/tmp/ws" }]);
    // The resumed session's id IS the requested one — session/load never mints a new one.
    expect(h.providerIds).toEqual(["prior-uuid"]);
  });

  it("falls back to a fresh session/new when session/load throws (e.g. the target session no longer exists)", async () => {
    const h = harness({ adapterId: "codex", resume: "gone-uuid" });
    h.connection.sessionLoadSupported = true;
    h.connection.failLoadSession = new Error("session not found");
    h.handle.send("hi");
    await flushMicrotasks();

    expect(h.connection.loadSessionCalls).toEqual([]);
    // Falls through to the real createSession path and gets a fresh id.
    expect(h.providerIds).toEqual(["uuid-session-1"]);
  });

  it("goes straight to session/new when no resume id was given, even if the adapter supports loadSession", async () => {
    const h = harness({ adapterId: "codex" });
    h.connection.sessionLoadSupported = true;
    h.handle.send("hi");
    await flushMicrotasks();

    expect(h.connection.loadSessionCalls).toEqual([]);
    expect(h.providerIds).toEqual(["uuid-session-1"]);
  });

  it("a startup failure surfaces once as a service envelope and never hangs sends", async () => {
    const h = harness({ failConnect: new Error("adapter not installed") });
    h.handle.send("hi", "env-1");
    await flushMicrotasks();

    const service = h.envelopes.find((e) => e.ev.t === "service");
    expect(service?.ev).toMatchObject({
      text: expect.stringContaining("adapter not installed"),
    });
    // No turn ran, so the claim-completion hook must NOT have fired.
    expect(h.settled).toEqual([]);
    await expect(h.handle.stop()).resolves.toEqual({ providerSessionId: null });
  });
});

describe("turn flow", () => {
  it("send emits the user envelope (caller id), turn-start, mapped updates, turn-end, and settles the claim hook", async () => {
    const h = harness();
    h.handle.send("do something", "envelope-42");
    await flushMicrotasks();

    expect(h.connection.prompts).toHaveLength(1);
    expect(h.connection.prompts[0]?.text).toBe("do something");

    h.connection.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    });
    h.connection.prompts[0]?.resolve({ stopReason: "end_turn" });
    await flushMicrotasks();
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("turn-end"));

    expect(eventTypes(h.envelopes)).toEqual(["text", "turn-start", "text", "turn-end"]);
    expect(h.envelopes[0]?.id).toBe("envelope-42");
    expect(h.envelopes[0]?.role).toBe("user");
    expect(h.envelopes[3]?.ev).toEqual({ t: "turn-end", status: "completed" });
    expect(h.settled).toEqual([{ messageId: "envelope-42", status: "completed" }]);
  });

  it("queues a second send until the first turn resolves (one prompt in flight)", async () => {
    const h = harness();
    h.handle.send("first", "e1");
    h.handle.send("second", "e2");
    await flushMicrotasks();

    expect(h.connection.prompts).toHaveLength(1);
    h.connection.prompts[0]?.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(h.connection.prompts).toHaveLength(2));
    expect(h.connection.prompts[1]?.text).toBe("second");
  });

  it("a cancelled stopReason closes the turn as cancelled and still settles the hook (terminal outcome)", async () => {
    const h = harness();
    h.handle.send("long task", "e1");
    await flushMicrotasks();

    await h.handle.interrupt();
    expect(h.connection.cancelled).toEqual(["uuid-session-1"]);

    h.connection.prompts[0]?.resolve({ stopReason: "cancelled" });
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("turn-end"));
    expect(h.envelopes.at(-1)?.ev).toEqual({ t: "turn-end", status: "cancelled" });
    expect(h.settled).toEqual([{ messageId: "e1", status: "cancelled" }]);
  });

  it("a REJECTED prompt closes the turn as failed but does NOT settle the hook (outcome indeterminate)", async () => {
    const h = harness();
    h.handle.send("doomed", "e1");
    await flushMicrotasks();

    h.connection.prompts[0]?.reject(new Error("adapter died"));
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("turn-end"));
    expect(h.envelopes.at(-1)?.ev).toEqual({ t: "turn-end", status: "failed" });
    expect(h.settled).toEqual([]);
  });
});

describe("permission pipeline wiring", () => {
  it("routes session/request_permission through the handler and setMode on a mode decision", async () => {
    const h = harness();
    h.handle.send("edit stuff", "e1");
    await flushMicrotasks();

    const responsePromise = h.connection.permissionHandler?.(
      {
        sessionId: "uuid-session-1",
        toolCall: {
          toolCallId: "tc1",
          rawInput: { file: "a.ts" },
          _meta: { claudeCode: { toolName: "Write" } },
        },
        options: [
          { optionId: "a", name: "Allow", kind: "allow_once" },
          { optionId: "r", name: "Reject", kind: "reject_once" },
        ],
      } as Parameters<PermissionRequestHandler>[0],
      1,
      new AbortController().signal,
    );

    await vi.waitFor(() => expect(h.envelopes.some((e) => e.ev.t === "perm-request")).toBe(true));
    const request = h.envelopes.find((e) => e.ev.t === "perm-request");
    const reqId = request?.ev.t === "perm-request" ? request.ev.reqId : "";
    expect(request?.ev).toMatchObject({ name: "Write" });

    const result = h.handle.resolvePermission({
      reqId,
      decision: { kind: "mode", mode: "acceptEdits" },
    });
    expect(result).toEqual({ ok: true });
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "a" },
    });
    await vi.waitFor(() =>
      expect(h.connection.modeCalls).toEqual([
        { sessionId: "uuid-session-1", modeId: "acceptEdits" },
      ]),
    );
  });

  it("setMode passes wire modes through as ACP mode ids for claude-code", async () => {
    const h = harness();
    h.handle.send("x");
    await flushMicrotasks();
    await h.handle.setMode("plan");
    expect(h.connection.modeCalls).toEqual([{ sessionId: "uuid-session-1", modeId: "plan" }]);
  });

  it("setMode maps wire modes to codex-acp's real mode ids (live-verified 2026-07-31: codex rejects the wire strings directly with 'Invalid params')", async () => {
    const h = harness({ adapterId: "codex" });
    h.handle.send("x");
    await flushMicrotasks();

    await h.handle.setMode("default");
    await h.handle.setMode("acceptEdits");
    await h.handle.setMode("plan");
    await h.handle.setMode("bypassPermissions");

    expect(h.connection.modeCalls).toEqual([
      { sessionId: "uuid-session-1", modeId: "agent" },
      { sessionId: "uuid-session-1", modeId: "agent" },
      { sessionId: "uuid-session-1", modeId: "read-only" },
      { sessionId: "uuid-session-1", modeId: "agent-full-access" },
    ]);
  });
});

describe("adapter death mid-turn", () => {
  it("surfaces a service envelope, closes the turn failed, and leaves the claim hook unfired", async () => {
    const h = harness();
    h.handle.send("work", "e1");
    await flushMicrotasks();

    h.connection.emitError("ACP adapter process exited with code 1");
    h.connection.prompts[0]?.reject(new Error("connection closed"));
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("service"));

    expect(eventTypes(h.envelopes)).toContain("turn-end");
    const turnEnd = h.envelopes.find((e) => e.ev.t === "turn-end");
    expect(turnEnd?.ev).toMatchObject({ status: "failed" });
    expect(h.settled).toEqual([]);
  });
});

describe("stop", () => {
  it("cancels, resets permissions, disconnects, and returns the provider session id", async () => {
    const h = harness();
    h.handle.send("x", "e1");
    await flushMicrotasks();

    const stopPromise = h.handle.stop();
    // stop cancels; the adapter answers the pending prompt as cancelled.
    h.connection.prompts[0]?.resolve({ stopReason: "cancelled" });
    await expect(stopPromise).resolves.toEqual({ providerSessionId: "uuid-session-1" });
    expect(h.connection.disconnected).toBe(true);
  });

  it("drops queued-but-unsent turns without settling their claim hooks", async () => {
    const h = harness();
    h.handle.send("first", "e1");
    h.handle.send("second-never-runs", "e2");
    await flushMicrotasks();

    const stopPromise = h.handle.stop();
    h.connection.prompts[0]?.resolve({ stopReason: "cancelled" });
    await stopPromise;

    expect(h.connection.prompts).toHaveLength(1);
    expect(h.settled.map((s) => s.messageId)).toEqual(["e1"]);
  });

  it("send after stop is dropped", async () => {
    const h = harness();
    const stopPromise = h.handle.stop();
    await stopPromise;
    h.handle.send("late");
    await flushMicrotasks();
    expect(h.connection.prompts).toHaveLength(0);
  });
});

// docs/plan-flows-3-4-5.md Flow 5's ACP correction (FL5.2): confirms the
// composition root (`startAcpRemote`) actually threads `sessionId`/
// `attention`/`reportSessionAttention` down into the `AcpPermissionHandler`
// it constructs (perm/question) and calls its `reportTurnEnd()` at this
// module's own turn-end path (done) — i.e. the wiring described in sub-task
// 2, not just the handler's own unit behavior (covered by
// acpPermissionHandler.test.ts).
describe("session attention wiring (docs/plan-flows-3-4-5.md Flow 5 — ACP correction)", () => {
  const attention: ReportSessionAttentionDeps = {
    backendUrl: "https://api.example",
    accessToken: "tok-1",
  };

  it("reports 'perm' for a session/request_permission call, threaded through from startAcpRemote's opts", async () => {
    const reportSessionAttention = vi.fn();
    const h = harness({ sessionId: "sess-9", attention, reportSessionAttention });
    h.handle.send("edit stuff", "e1");
    await flushMicrotasks();

    void h.connection.permissionHandler?.(
      {
        sessionId: "uuid-session-1",
        toolCall: {
          toolCallId: "tc1",
          rawInput: { file: "a.ts" },
          _meta: { claudeCode: { toolName: "Write" } },
        },
        options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
      } as Parameters<PermissionRequestHandler>[0],
      1,
      new AbortController().signal,
    );

    expect(reportSessionAttention).toHaveBeenCalledExactlyOnceWith(attention, {
      sessionId: "sess-9",
      kind: "perm",
    });
  });

  it("reports 'done' when a turn completes (drain()'s turn-end path), not on cancel/reject", async () => {
    const reportSessionAttention = vi.fn();
    const h = harness({ sessionId: "sess-9", attention, reportSessionAttention });
    h.handle.send("do something", "e1");
    await flushMicrotasks();

    h.connection.prompts[0]?.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("turn-end"));

    expect(reportSessionAttention).toHaveBeenCalledExactlyOnceWith(attention, {
      sessionId: "sess-9",
      kind: "done",
    });
  });

  it("does NOT report 'done' when the prompt is REJECTED (indeterminate outcome, same rule as onTurnSettled)", async () => {
    const reportSessionAttention = vi.fn();
    const h = harness({ sessionId: "sess-9", attention, reportSessionAttention });
    h.handle.send("doomed", "e1");
    await flushMicrotasks();

    h.connection.prompts[0]?.reject(new Error("adapter died"));
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("turn-end"));

    expect(reportSessionAttention).not.toHaveBeenCalled();
  });

  it("is a no-op when sessionId/attention aren't passed (no live caller wired yet)", async () => {
    const reportSessionAttention = vi.fn();
    const h = harness({ reportSessionAttention }); // no sessionId/attention
    h.handle.send("do something", "e1");
    await flushMicrotasks();
    h.connection.prompts[0]?.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(eventTypes(h.envelopes)).toContain("turn-end"));

    expect(reportSessionAttention).not.toHaveBeenCalled();
  });
});
