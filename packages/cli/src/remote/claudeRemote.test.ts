import type { Query, query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { startClaudeRemote } from "./claudeRemote.js";
import type { PushableAsyncIterable } from "./pushableAsyncIterable.js";

/** Minimal fake standing in for the SDK's `Query` (AsyncGenerator + control methods). */
class FakeQuery {
  private idx = 0;
  interrupt = vi.fn(async () => undefined);
  setPermissionMode = vi.fn(async () => undefined);
  close = vi.fn();

  constructor(private readonly messages: unknown[]) {}

  async next(): Promise<IteratorResult<unknown, undefined>> {
    if (this.idx < this.messages.length) {
      return { done: false, value: this.messages[this.idx++] };
    }
    return { done: true, value: undefined };
  }

  async return(): Promise<IteratorResult<unknown, undefined>> {
    return { done: true, value: undefined };
  }

  async throw(e: unknown): Promise<IteratorResult<unknown, undefined>> {
    throw e;
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startClaudeRemote", () => {
  it("converts the SDK stream to envelopes and delivers them via onEnvelopes", async () => {
    const fakeQuery = new FakeQuery([
      {
        type: "assistant",
        uuid: "a-1",
        session_id: "prov-1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);
    const queryImpl = vi.fn(() => fakeQuery as unknown as Query);
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    startClaudeRemote(
      {
        workingDirectory: "/tmp/work",
        permissionMode: "default",
        onEnvelopes,
      },
      { queryImpl },
    );

    await flushMicrotasks();

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered.map((e) => e.ev.t)).toEqual(["turn-start", "text"]);
  });

  it("calls onProviderSessionId once per newly-observed session_id", async () => {
    const fakeQuery = new FakeQuery([
      {
        type: "assistant",
        uuid: "a-1",
        session_id: "prov-1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "one" }] },
      },
      {
        type: "assistant",
        uuid: "a-2",
        session_id: "prov-1",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
      },
    ]);
    const queryImpl = vi.fn(() => fakeQuery as unknown as Query);
    const onProviderSessionId = vi.fn<(id: string) => void>();

    startClaudeRemote(
      {
        workingDirectory: "/tmp/work",
        permissionMode: "default",
        onEnvelopes: () => {},
        onProviderSessionId,
      },
      { queryImpl },
    );

    await flushMicrotasks();

    expect(onProviderSessionId).toHaveBeenCalledExactlyOnceWith("prov-1");
  });

  it("send() emits a user text envelope directly and pushes an SDKUserMessage onto the prompt stream", async () => {
    const fakeQuery = new FakeQuery([]);
    let capturedPrompt: PushableAsyncIterable<unknown> | undefined;
    const queryImpl = vi.fn((params: { prompt: unknown }) => {
      capturedPrompt = params.prompt as PushableAsyncIterable<unknown>;
      return fakeQuery as unknown as Query;
    });
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { queryImpl },
    );

    handle.send("hi there");
    await flushMicrotasks();

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    expect(delivered).toEqual([
      expect.objectContaining({ role: "user", ev: { t: "text", md: "hi there" } }),
    ]);

    const pushed = await capturedPrompt?.next();
    expect(pushed?.value).toEqual({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: "hi there" },
    });
  });

  it("interrupt() delegates to the underlying query's interrupt()", async () => {
    const fakeQuery = new FakeQuery([]);
    const queryImpl = vi.fn(() => fakeQuery as unknown as Query);
    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes: () => {} },
      { queryImpl },
    );

    await handle.interrupt();
    expect(fakeQuery.interrupt).toHaveBeenCalledOnce();
  });

  it("setMode() delegates to the underlying query's setPermissionMode()", async () => {
    const fakeQuery = new FakeQuery([]);
    const queryImpl = vi.fn(() => fakeQuery as unknown as Query);
    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes: () => {} },
      { queryImpl },
    );

    await handle.setMode("acceptEdits");
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledExactlyOnceWith("acceptEdits");
  });

  it("stop() interrupts, closes the query, force-closes any open turn, and resolves with the last providerSessionId", async () => {
    const fakeQuery = new FakeQuery([
      {
        type: "assistant",
        uuid: "a-1",
        session_id: "prov-9",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    const queryImpl = vi.fn(() => fakeQuery as unknown as Query);
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { queryImpl },
    );
    await flushMicrotasks();

    const result = await handle.stop();

    expect(result).toEqual({ providerSessionId: "prov-9" });
    expect(fakeQuery.interrupt).toHaveBeenCalledOnce();
    expect(fakeQuery.close).toHaveBeenCalledOnce();

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    // The turn opened by the assistant message above must have been closed
    // (cancelled) as part of stop(), even though the fake query never emits
    // its own `result` message.
    expect(delivered.some((e) => e.ev.t === "turn-end" && e.ev.status === "cancelled")).toBe(true);
  });

  it("stop() is idempotent", async () => {
    const fakeQuery = new FakeQuery([]);
    const queryImpl = vi.fn(() => fakeQuery as unknown as Query);
    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes: () => {} },
      { queryImpl },
    );

    await handle.stop();
    await handle.stop();
    expect(fakeQuery.close).toHaveBeenCalledOnce();
  });

  it("defaults canUseTool to a real permission pipeline: a dangerous tool call emits a perm-request envelope and resolvePermission() answers it first-wins", async () => {
    const fakeQuery = new FakeQuery([]);
    let capturedCanUseTool: unknown;
    const queryImpl = vi.fn((params: { prompt: unknown; options: { canUseTool: unknown } }) => {
      capturedCanUseTool = params.options.canUseTool;
      return fakeQuery as unknown as Query;
    }) as unknown as typeof query;
    const onEnvelopes = vi.fn<(e: SessionEnvelope[]) => void>();

    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes },
      { queryImpl },
    );

    const canUseTool = capturedCanUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal },
    ) => Promise<unknown>;
    const pending = canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    await flushMicrotasks();

    const delivered = onEnvelopes.mock.calls.flatMap(([envs]) => envs);
    const permRequest = delivered.find((e) => e.ev.t === "perm-request");
    expect(permRequest).toBeDefined();
    const reqId = (permRequest?.ev as { reqId: string }).reqId;

    const first = handle.resolvePermission({ reqId, decision: { kind: "allow", scope: "once" } });
    const second = handle.resolvePermission({ reqId, decision: { kind: "deny" } });

    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false, reason: "already-answered" });
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("setMode() syncs the permission handler's mode so a later tool call is auto-approved accordingly", async () => {
    const fakeQuery = new FakeQuery([]);
    let capturedCanUseTool: unknown;
    const queryImpl = vi.fn((params: { prompt: unknown; options: { canUseTool: unknown } }) => {
      capturedCanUseTool = params.options.canUseTool;
      return fakeQuery as unknown as Query;
    }) as unknown as typeof query;

    const handle = startClaudeRemote(
      { workingDirectory: "/tmp/work", permissionMode: "default", onEnvelopes: () => {} },
      { queryImpl },
    );

    await handle.setMode("bypassPermissions");

    const canUseTool = capturedCanUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal },
    ) => Promise<unknown>;
    const result = await canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ behavior: "allow" });
  });
});
