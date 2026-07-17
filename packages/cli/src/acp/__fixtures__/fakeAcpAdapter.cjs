#!/usr/bin/env node
/**
 * Standalone fake ACP adapter child process for `acpConnection.test.ts`.
 *
 * Speaks raw NDJSON-over-stdio JSON-RPC (no `@agentclientprotocol/sdk`
 * dependency of its own) so `acpConnection.ts` can be exercised against a
 * real spawned child exactly the way it would talk to a real
 * `claude-agent-acp`/`codex-acp` install — not just a mocked SDK object.
 * Behavior is selected via the `FAKE_ACP_MODE` env var so one small script
 * covers every scenario the test suite needs:
 *
 *  - "normal" (default): initialize -> session/new -> session/prompt emits
 *    one `session/update` then resolves `{stopReason:'end_turn'}`.
 *  - "crash-on-init": writes a few stderr lines then exits(1) before ever
 *    responding to `initialize` — exercises the connect-failure stderr tail.
 *  - "crash-after-ready": exits(1) with stderr output shortly after
 *    responding to `initialize` — exercises the post-ready close/error path.
 *  - "huge-meta": the `session/update` emitted during a prompt carries an
 *    oversized `_meta` blob, to exercise the cheap `_meta` bounds check.
 *  - "permission-request": before resolving `session/prompt`, sends an
 *    agent-initiated `session/request_permission` request and folds the
 *    response's outcome into the final `stopReason`.
 *  - "slow-prompt": `session/prompt` never resolves on its own — only
 *    responds once it receives a `session/cancel` notification for the same
 *    session, replying `{stopReason:'cancelled'}`. Exercises `cancel()`.
 */
const { createInterface } = require("node:readline");

const mode = process.env.FAKE_ACP_MODE ?? "normal";

let sessionCounter = 0;
let nextOutgoingRequestId = 1;
/** sessionId -> JSON-RPC request id of its in-flight `session/prompt` */
const pendingPrompts = new Map();
/** our own outgoing request id -> resolver for its eventual response */
const pendingOutgoingRequests = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sendAgentRequest(method, params) {
  const id = nextOutgoingRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => {
    pendingOutgoingRequests.set(id, resolve);
  });
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  pendingPrompts.set(sessionId, id);

  if (mode === "huge-meta") {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
      _meta: { blob: "x".repeat(64 * 1024) },
    });
  } else {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from fake agent" },
      },
    });
  }

  if (mode === "slow-prompt") {
    // Resolved only by a later `session/cancel` notification.
    return;
  }

  if (mode === "permission-request") {
    const response = await sendAgentRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tool-1" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    pendingPrompts.delete(sessionId);
    const outcome = response?.outcome;
    if (outcome?.outcome === "selected" && outcome.optionId === "allow") {
      respond(id, { stopReason: "end_turn" });
    } else {
      respond(id, { stopReason: "refusal" });
    }
    return;
  }

  setTimeout(() => {
    if (pendingPrompts.get(sessionId) !== id) return; // already resolved (e.g. cancelled)
    pendingPrompts.delete(sessionId);
    respond(id, { stopReason: "end_turn" });
  }, 10);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      if (mode === "crash-on-init") {
        process.stderr.write("fake-adapter: simulated crash before initialize response\n");
        process.stderr.write("fake-adapter: diagnostic line 2\n");
        process.exitCode = 1;
        process.exit(1);
      }
      respond(id, {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: {},
        },
        agentInfo: { name: "fake-acp-adapter", version: "0.0.1" },
        authMethods: [],
      });
      if (mode === "crash-after-ready") {
        setTimeout(() => {
          process.stderr.write("fake-adapter: simulated crash after ready\n");
          process.exitCode = 1;
          process.exit(1);
        }, 15);
      }
      return;
    }
    case "session/new": {
      sessionCounter += 1;
      const sessionId = `sess-${sessionCounter}`;
      respond(id, { sessionId, modes: null });
      return;
    }
    case "session/load":
    case "session/resume": {
      respond(id, { modes: null });
      return;
    }
    case "session/set_mode": {
      respond(id, {});
      return;
    }
    case "session/prompt": {
      await handlePrompt(id, params);
      return;
    }
    default: {
      respondError(id, -32601, `fake-adapter: method not found: ${method}`);
    }
  }
}

function handleNotification(message) {
  const { method, params } = message;
  if (method === "session/cancel") {
    const sessionId = params?.sessionId;
    const pendingId = pendingPrompts.get(sessionId);
    if (pendingId !== undefined) {
      pendingPrompts.delete(sessionId);
      respond(pendingId, { stopReason: "cancelled" });
    }
  }
}

function handleResponse(message) {
  const resolver = pendingOutgoingRequests.get(message.id);
  if (!resolver) return;
  pendingOutgoingRequests.delete(message.id);
  resolver("error" in message ? undefined : message.result);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof message.method === "string" && "id" in message) {
    void handleRequest(message);
  } else if (typeof message.method === "string") {
    handleNotification(message);
  } else if ("id" in message) {
    handleResponse(message);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
