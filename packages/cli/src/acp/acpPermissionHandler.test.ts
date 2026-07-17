import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { AcpPermissionHandler, type AgentStateSnapshot } from "./acpPermissionHandler.js";

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const STANDARD_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

function permissionRequest(
  overrides: Partial<RequestPermissionRequest> = {},
): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "call-1",
      title: "run pnpm build",
      kind: "execute",
      rawInput: { command: "pnpm build" },
      _meta: { claudeCode: { toolName: "Bash" } },
    },
    options: STANDARD_OPTIONS,
    ...overrides,
  } as RequestPermissionRequest;
}

interface Harness {
  handler: AcpPermissionHandler;
  envelopes: SessionEnvelope[];
  snapshots: AgentStateSnapshot[];
  modeChanges: string[];
  logger: Logger;
}

function harness(): Harness {
  const envelopes: SessionEnvelope[] = [];
  const snapshots: AgentStateSnapshot[] = [];
  const modeChanges: string[] = [];
  const logger = fakeLogger();
  const handler = new AcpPermissionHandler({
    emitEnvelope: (envelope) => envelopes.push(envelope),
    onAgentStateChange: (snapshot) => snapshots.push(snapshot),
    onModeChange: (mode) => modeChanges.push(mode),
    logger,
  });
  return { handler, envelopes, snapshots, modeChanges, logger };
}

function reqIdFrom(envelopes: SessionEnvelope[]): string {
  const request = envelopes.find((e) => e.ev.t === "perm-request");
  if (!request || request.ev.t !== "perm-request") throw new Error("no perm-request emitted");
  return request.ev.reqId;
}

describe("handleRequest → perm-request envelope", () => {
  it("emits a perm-request with the provider tool name, args, and offered modes", () => {
    const h = harness();
    const controller = new AbortController();
    void h.handler.handleRequest(permissionRequest(), controller.signal);

    expect(h.envelopes).toHaveLength(1);
    const ev = h.envelopes[0]?.ev;
    expect(ev).toMatchObject({
      t: "perm-request",
      name: "Bash",
      args: { command: "pnpm build" },
      modes: ["default", "acceptEdits", "plan", "bypassPermissions"],
    });
    expect(h.handler.pendingCount).toBe(1);
    expect(h.snapshots.at(-1)?.requests).toHaveProperty(reqIdFrom(h.envelopes));
  });

  it("offers no 'plan' mode for ExitPlanMode", () => {
    const h = harness();
    const controller = new AbortController();
    void h.handler.handleRequest(
      permissionRequest({
        toolCall: {
          toolCallId: "call-2",
          _meta: { claudeCode: { toolName: "ExitPlanMode" } },
        } as RequestPermissionRequest["toolCall"],
      }),
      controller.signal,
    );
    const ev = h.envelopes[0]?.ev;
    expect(ev).toMatchObject({
      t: "perm-request",
      name: "ExitPlanMode",
      modes: ["default", "acceptEdits", "bypassPermissions"],
    });
  });

  it("falls back to ACP kind then 'tool' when no claudeCode toolName is present", () => {
    const h = harness();
    void h.handler.handleRequest(
      permissionRequest({
        toolCall: {
          toolCallId: "call-3",
          kind: "edit",
        } as RequestPermissionRequest["toolCall"],
      }),
      new AbortController().signal,
    );
    expect(h.envelopes[0]?.ev).toMatchObject({ t: "perm-request", name: "edit" });
  });
});

describe("resolve → ACP option selection", () => {
  it("allow once selects the allow_once option and emits perm-resolve", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    const reqId = reqIdFrom(h.envelopes);

    const result = h.handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(result).toEqual({ ok: true });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(h.envelopes.at(-1)?.ev).toMatchObject({ t: "perm-resolve", reqId });
    expect(h.snapshots.at(-1)?.completedRequests[reqId]?.status).toBe("approved");
  });

  it("allow for session prefers allow_always", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    h.handler.resolve({
      reqId: reqIdFrom(h.envelopes),
      decision: { kind: "allow", scope: "session" },
    });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-always" },
    });
  });

  it("allow for session falls back to allow_once when the agent offers no allow_always", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(
      permissionRequest({
        options: [
          { optionId: "only-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      }),
      new AbortController().signal,
    );
    h.handler.resolve({
      reqId: reqIdFrom(h.envelopes),
      decision: { kind: "allow", scope: "session" },
    });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "only-once" },
    });
  });

  it("deny selects reject_once and records status denied", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    const reqId = reqIdFrom(h.envelopes);
    h.handler.resolve({ reqId, decision: { kind: "deny", message: "nope" } });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(h.snapshots.at(-1)?.completedRequests[reqId]?.status).toBe("denied");
  });

  it("mode decision fires onModeChange and resolves as an allow", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    h.handler.resolve({
      reqId: reqIdFrom(h.envelopes),
      decision: { kind: "mode", mode: "acceptEdits" },
    });
    expect(h.modeChanges).toEqual(["acceptEdits"]);
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("allow with updatedInput still allows (ACP has no modified-input channel) and warns", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    h.handler.resolve({
      reqId: reqIdFrom(h.envelopes),
      decision: { kind: "allow", scope: "once", updatedInput: { command: "echo safe" } },
    });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("updatedInput"),
      expect.anything(),
    );
  });

  it("cancels (rather than hangs) when the agent offers no matching option kind", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(
      permissionRequest({
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      }),
      new AbortController().signal,
    );
    h.handler.resolve({ reqId: reqIdFrom(h.envelopes), decision: { kind: "deny" } });
    await expect(promise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("first-wins resolution", () => {
  it("the second perm.answer for the same reqId loses with the winning decision attached", async () => {
    const h = harness();
    const promise = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    const reqId = reqIdFrom(h.envelopes);

    const winner = h.handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    const loser = h.handler.resolve({ reqId, decision: { kind: "deny" } });

    expect(winner).toEqual({ ok: true });
    expect(loser).toEqual({
      ok: false,
      reason: "already-answered",
      decision: { kind: "allow", scope: "once" },
    });
    await promise;
  });

  it("an unknown reqId reports already-answered without a decision", () => {
    const h = harness();
    expect(h.handler.resolve({ reqId: "nope", decision: { kind: "deny" } })).toEqual({
      ok: false,
      reason: "already-answered",
    });
  });
});

describe("cancellation", () => {
  it("an aborted ACP request settles as cancelled and emits a denied perm-resolve", async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = h.handler.handleRequest(permissionRequest(), controller.signal);
    const reqId = reqIdFrom(h.envelopes);

    controller.abort();
    await expect(promise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(h.envelopes.at(-1)?.ev).toMatchObject({
      t: "perm-resolve",
      reqId,
      decision: { kind: "deny", message: "Permission request cancelled" },
    });
    expect(h.snapshots.at(-1)?.completedRequests[reqId]?.status).toBe("canceled");
    expect(h.handler.pendingCount).toBe(0);
  });

  it("an already-aborted signal settles immediately without emitting a perm-request", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.handler.handleRequest(permissionRequest(), controller.signal)).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(h.envelopes).toHaveLength(0);
  });

  it("reset() settles every in-flight request as cancelled with the given reason", async () => {
    const h = harness();
    const p1 = h.handler.handleRequest(permissionRequest(), new AbortController().signal);
    const p2 = h.handler.handleRequest(
      permissionRequest({
        toolCall: { toolCallId: "call-9" } as RequestPermissionRequest["toolCall"],
      }),
      new AbortController().signal,
    );
    expect(h.handler.pendingCount).toBe(2);

    h.handler.reset("Back to local");
    await expect(p1).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(p2).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    const resolves = h.envelopes.filter((e) => e.ev.t === "perm-resolve");
    expect(resolves).toHaveLength(2);
    expect(resolves[0]?.ev).toMatchObject({
      decision: { kind: "deny", message: "Back to local" },
    });
    expect(h.handler.pendingCount).toBe(0);
  });

  it("a resolve after abort loses cleanly (no double settle)", async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = h.handler.handleRequest(permissionRequest(), controller.signal);
    const reqId = reqIdFrom(h.envelopes);
    controller.abort();
    await promise;

    const late = h.handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(late).toEqual({
      ok: false,
      reason: "already-answered",
      decision: { kind: "deny", message: "Permission request cancelled" },
    });
  });
});
