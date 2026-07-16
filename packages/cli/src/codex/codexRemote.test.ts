import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalHandler,
  CodexAppServerClient,
  EventHandler,
} from "./codexAppServerClient.js";
import type { EventMsg } from "./codexAppServerTypes.js";
import { startCodexRemote } from "./codexRemote.js";

/** Minimal fake standing in for `CodexAppServerClient`. */
class FakeCodexAppServerClient {
  threadId: string | null = null;
  turnId: string | null = null;
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => {
    this.threadId = null;
  });
  startThread = vi.fn(async () => {
    this.threadId = "thread-1";
    return { threadId: "thread-1", model: "gpt-5-codex" };
  });
  resumeThread = vi.fn(async (opts: { threadId: string }) => {
    this.threadId = opts.threadId;
    return { threadId: opts.threadId, model: "gpt-5-codex" };
  });
  sendTurn = vi.fn(async () => {
    this.turnId = "turn-1";
    return { turnId: "turn-1" };
  });
  interruptTurn = vi.fn(async () => undefined);
  approvalHandler: ApprovalHandler | null = null;
  eventHandler: EventHandler | null = null;

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }
  setEventHandler(handler: EventHandler): void {
    this.eventHandler = handler;
  }
  emit(msg: EventMsg): void {
    this.eventHandler?.(msg);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startCodexRemote", () => {
  it("connects, starts a fresh thread, and reports the thread id", async () => {
    const client = new FakeCodexAppServerClient();
    const onThreadId = vi.fn();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes, onThreadId },
      { client: client as unknown as CodexAppServerClient },
    );

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.startThread).toHaveBeenCalledOnce();
    expect(client.resumeThread).not.toHaveBeenCalled();
    expect(onThreadId).toHaveBeenCalledWith("thread-1");
  });

  it("resumes an existing thread when opts.resume is set", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    await startCodexRemote(
      {
        workingDirectory: "/tmp/work",
        permissionMode: "default",
        resume: "thread-42",
        onEnvelopes,
      },
      { client: client as unknown as CodexAppServerClient },
    );

    expect(client.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-42" }),
    );
    expect(client.startThread).not.toHaveBeenCalled();
  });

  it("forwards mapped codex/event notifications to onEnvelopes in order", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { client: client as unknown as CodexAppServerClient },
    );

    client.emit({ type: "task_started" });
    client.emit({ type: "agent_message", message: "hi" });
    await flushMicrotasks();

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.map((e) => e.ev.t)).toEqual(["turn-start", "text"]);
  });

  it("send() closes the previous turn, emits the user's text, then calls client.sendTurn", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const handle = await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { client: client as unknown as CodexAppServerClient },
    );

    await handle.send("hello codex");
    await flushMicrotasks();

    expect(client.sendTurn).toHaveBeenCalledWith("hello codex", expect.any(Object));
    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.map((e) => e.ev.t)).toContain("text");
  });

  it("interrupt() delegates to client.interruptTurn", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const handle = await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { client: client as unknown as CodexAppServerClient },
    );

    await handle.interrupt();
    expect(client.interruptTurn).toHaveBeenCalledOnce();
  });

  it("resolvePermission() routes through the internal CodexPermissionHandler and unblocks a pending approval", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const handle = await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { client: client as unknown as CodexAppServerClient },
    );

    expect(client.approvalHandler).not.toBeNull();
    const decisionPromise = client.approvalHandler?.({
      type: "exec",
      callId: "call-1",
      command: ["ls"],
    });
    await flushMicrotasks();

    const emitted = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    const permRequest = emitted.find((e) => e.ev.t === "perm-request");
    if (!permRequest) throw new Error("expected a perm-request envelope");
    const reqId = (permRequest.ev as { reqId: string }).reqId;

    const outcome = handle.resolvePermission({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(outcome).toEqual({ ok: true });
    await expect(decisionPromise).resolves.toBe("approved");
  });

  it("stop() interrupts, resets permissions, closes the turn as cancelled, and disconnects", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const handle = await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { client: client as unknown as CodexAppServerClient },
    );

    client.emit({ type: "task_started" });
    await flushMicrotasks();

    const result = await handle.stop();

    expect(client.interruptTurn).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(result).toEqual({ threadId: "thread-1" });

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.at(-1)?.ev).toEqual({ t: "turn-end", status: "cancelled" });
  });

  it("stop() is idempotent — a second call doesn't disconnect again", async () => {
    const client = new FakeCodexAppServerClient();
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();
    const handle = await startCodexRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { client: client as unknown as CodexAppServerClient },
    );

    await handle.stop();
    await handle.stop();

    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
