import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, type CodexProcessLike } from "./codexAppServerClient.js";

interface FakeRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
}

function createFakeProcess(autoRespond: (method: string, params: unknown, id: number) => unknown) {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: FakeRpcMessage[] = [];

  const stdin = {
    writable: true,
    write: (chunk: string) => {
      const msg = JSON.parse(chunk) as FakeRpcMessage;
      written.push(msg);
      if (msg.id != null && msg.method) {
        const result = autoRespond(msg.method, msg.params, msg.id);
        if (result !== undefined) {
          queueMicrotask(() => {
            stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
          });
        }
      }
    },
    end: () => {},
  };

  const proc: CodexProcessLike = {
    pid: 4242,
    stdin,
    stdout,
    stderr,
    on: (event, listener) => {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    kill: () => true,
  };

  return { proc, stdout, stderr, written, emitter };
}

function defaultAutoRespond(method: string): unknown {
  if (method === "initialize") return { userAgent: "codex-cli-test" };
  if (method === "thread/start" || method === "thread/resume") {
    return {
      thread: { id: "thread-1", path: "/tmp/thread-1" },
      model: "gpt-5-codex",
      approvalPolicy: "on-request",
    };
  }
  if (method === "turn/start") return { turn: { id: "turn-1" } };
  if (method === "turn/interrupt") return { abortReason: "interrupted" };
  return {};
}

describe("CodexAppServerClient: connect handshake", () => {
  it("sends initialize then an 'initialized' notification, and becomes connected", async () => {
    const { proc, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });

    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(written[0]?.method).toBe("initialize");
    expect(written[1]?.method).toBe("initialized");
    expect(written[1]?.id).toBeUndefined(); // a notification, not a request
  });

  it("is idempotent — a second connect() while already connected is a no-op", async () => {
    const { proc, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    await client.connect();
    expect(written.filter((m) => m.method === "initialize")).toHaveLength(1);
  });
});

describe("CodexAppServerClient: thread lifecycle", () => {
  it("startThread sends thread/start and records the returned threadId", async () => {
    const { proc } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();

    const result = await client.startThread({ cwd: "/tmp/work" });

    expect(result).toEqual({ threadId: "thread-1", model: "gpt-5-codex" });
    expect(client.threadId).toBe("thread-1");
  });

  it("resumeThread sends thread/resume with the given threadId", async () => {
    const { proc, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();

    await client.resumeThread({ threadId: "thread-1", cwd: "/tmp/work" });

    const resumeMsg = written.find((m) => m.method === "thread/resume");
    if (!resumeMsg) throw new Error("expected a thread/resume request");
    expect((resumeMsg.params as { threadId: string }).threadId).toBe("thread-1");
    expect(client.threadId).toBe("thread-1");
  });

  it("sendTurn requires an active thread", async () => {
    const { proc } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    await expect(client.sendTurn("hi")).rejects.toThrow(/No active thread/);
  });

  it("sendTurn sends turn/start scoped to the active thread and records the turnId", async () => {
    const { proc, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    await client.startThread({});

    const result = await client.sendTurn("hello codex");

    expect(result).toEqual({ turnId: "turn-1" });
    expect(client.turnId).toBe("turn-1");
    const turnMsg = written.find((m) => m.method === "turn/start");
    expect(turnMsg?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello codex" }],
    });
  });

  it("interruptTurn is a no-op without an active turn, and sends turn/interrupt with one", async () => {
    const { proc, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    await client.interruptTurn();
    expect(written.some((m) => m.method === "turn/interrupt")).toBe(false);

    await client.startThread({});
    await client.sendTurn("hi");
    await client.interruptTurn();
    expect(written.some((m) => m.method === "turn/interrupt")).toBe(true);
  });
});

describe("CodexAppServerClient: approval routing", () => {
  it("routes a legacy execCommandApproval server request to the approval handler and responds with its raw decision", async () => {
    const { proc, stdout, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();

    let seenRequest: unknown;
    client.setApprovalHandler(async (request) => {
      seenRequest = request;
      return "approved";
    });

    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        method: "execCommandApproval",
        params: { callId: "call-abc", command: ["ls", "-la"], cwd: "/tmp" },
      })}\n`,
    );

    await vi.waitFor(() => {
      const response = written.find(
        (m) => (m as { id?: number }).id === 999 && m.method === undefined,
      );
      expect(response).toBeDefined();
    });

    expect(seenRequest).toMatchObject({ type: "exec", callId: "call-abc", command: ["ls", "-la"] });
    const response = written.find((m) => (m as { id?: number }).id === 999) as unknown as {
      result: { decision: string };
    };
    expect(response.result.decision).toBe("approved");
  });

  it("routes a v2 item/commandExecution/requestApproval request and maps the decision to v2 wire values", async () => {
    const { proc, stdout, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    client.setApprovalHandler(async () => "approved_for_session");

    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1000,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", itemId: "item-1", command: "ls" },
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(written.some((m) => (m as { id?: number }).id === 1000)).toBe(true);
    });
    const response = written.find((m) => (m as { id?: number }).id === 1000) as unknown as {
      result: { decision: string };
    };
    expect(response.result.decision).toBe("acceptForSession");
  });

  it("routes patch approval requests (legacy and v2 method names)", async () => {
    const { proc, stdout, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    let seenRequest: unknown;
    client.setApprovalHandler(async (request) => {
      seenRequest = request;
      return "denied";
    });

    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1001,
        method: "applyPatchApproval",
        params: { callId: "patch-1", fileChanges: { "a.txt": { type: "add", content: "hi" } } },
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(written.some((m) => (m as { id?: number }).id === 1001)).toBe(true);
    });
    expect(seenRequest).toMatchObject({ type: "patch", callId: "patch-1" });
    const response = written.find((m) => (m as { id?: number }).id === 1001) as unknown as {
      result: { decision: string };
    };
    expect(response.result.decision).toBe("denied");
  });

  it("denies (and still responds) when no approval handler is set", async () => {
    const { proc, stdout, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();

    stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1002,
        method: "execCommandApproval",
        params: { callId: "call-x", command: ["ls"] },
      })}\n`,
    );

    await vi.waitFor(() => {
      expect(written.some((m) => (m as { id?: number }).id === 1002)).toBe(true);
    });
    const response = written.find((m) => (m as { id?: number }).id === 1002) as unknown as {
      result: { decision: string };
    };
    expect(response.result.decision).toBe("denied");
  });

  it("responds with {} to an unknown server request instead of hanging", async () => {
    const { proc, stdout, written } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();

    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1003, method: "someFutureMethod", params: {} })}\n`,
    );

    await vi.waitFor(() => {
      expect(written.some((m) => (m as { id?: number }).id === 1003)).toBe(true);
    });
    const response = written.find((m) => (m as { id?: number }).id === 1003) as unknown as {
      result: unknown;
    };
    expect(response.result).toEqual({});
  });
});

describe("CodexAppServerClient: notifications", () => {
  it("forwards codex/event messages to the event handler", async () => {
    const { proc, stdout } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();

    const received: unknown[] = [];
    client.setEventHandler((msg) => received.push(msg));

    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "agent_message", message: "hi" } } })}\n`,
    );

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toEqual({ type: "agent_message", message: "hi" });
  });

  it("tracks turnId from task_started/task_complete events", async () => {
    const { proc, stdout } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    client.setEventHandler(() => {});

    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "task_started", turn_id: "turn-99" } } })}\n`,
    );
    await vi.waitFor(() => expect(client.turnId).toBe("turn-99"));

    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "task_complete" } } })}\n`,
    );
    await vi.waitFor(() => expect(client.turnId).toBeNull());
  });
});

describe("CodexAppServerClient: process lifecycle", () => {
  it("rejects pending requests when the process exits", async () => {
    const { proc, emitter } = createFakeProcess(() => undefined);
    const client = new CodexAppServerClient({ spawn: () => proc, requestTimeoutMs: 5_000 });

    const connectPromise = client.connect();
    emitter.emit("exit", 1, null);

    await expect(connectPromise).rejects.toThrow(/Codex process exited/);
  });

  it("disconnect() ends stdin, kills the process, and clears thread/turn state", async () => {
    const { proc } = createFakeProcess(defaultAutoRespond);
    const client = new CodexAppServerClient({ spawn: () => proc });
    await client.connect();
    await client.startThread({});

    await client.disconnect();

    expect(client.isConnected).toBe(false);
    expect(client.threadId).toBeNull();
  });
});
