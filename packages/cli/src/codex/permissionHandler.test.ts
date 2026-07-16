import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "./codexAppServerClient.js";
import { CodexPermissionHandler } from "./permissionHandler.js";

function createHandler(
  overrides: Partial<ConstructorParameters<typeof CodexPermissionHandler>[0]> = {},
) {
  const envelopes: SessionEnvelope[] = [];
  const handler = new CodexPermissionHandler({
    emitEnvelope: (envelope) => envelopes.push(envelope),
    ...overrides,
  });
  return { handler, envelopes };
}

function lastReqId(envelopes: SessionEnvelope[]): string {
  const ev = envelopes.at(-1)?.ev;
  if (!ev) throw new Error("lastReqId: no envelope has been emitted yet");
  return (ev as { reqId: string }).reqId;
}

const execRequest: ApprovalRequest = {
  type: "exec",
  callId: "call_1",
  command: ["ls", "-la"],
  cwd: "/tmp",
};
const patchRequest: ApprovalRequest = {
  type: "patch",
  callId: "call_2",
  fileChanges: { "a.txt": { type: "add", content: "hi" } },
};

describe("CodexPermissionHandler auto-rules", () => {
  it("approves everything in bypassPermissions mode", async () => {
    const { handler } = createHandler({ initialMode: "bypassPermissions" });
    await expect(handler.handleApproval(execRequest)).resolves.toBe("approved");
    await expect(handler.handleApproval(patchRequest)).resolves.toBe("approved");
  });

  it("auto-approves patch requests but still prompts for exec in acceptEdits mode", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "acceptEdits" });

    await expect(handler.handleApproval(patchRequest)).resolves.toBe("approved");

    const pending = handler.handleApproval(execRequest);
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    const reqId = lastReqId(envelopes);
    handler.resolve({ reqId, decision: { kind: "deny" } });
    await expect(pending).resolves.toBe("denied");
  });

  it("prompts for both exec and patch requests in default mode", async () => {
    const { handler, envelopes } = createHandler();

    const pending = handler.handleApproval(execRequest);
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    const reqId = lastReqId(envelopes);
    handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    await expect(pending).resolves.toBe("approved");
  });

  it("emits perm-request with the modes Codex actually supports", async () => {
    const { handler, envelopes } = createHandler();
    const pending = handler.handleApproval(execRequest);
    const ev = envelopes.at(-1)?.ev as { modes: string[] };
    expect(ev.modes).toEqual(["acceptEdits", "bypassPermissions"]);
    handler.resolve({ reqId: lastReqId(envelopes), decision: { kind: "deny" } });
    await pending;
  });
});

describe("CodexPermissionHandler allow-for-session", () => {
  it("remembers an exec literal for the rest of the session", async () => {
    const { handler, envelopes } = createHandler();

    const first = handler.handleApproval(execRequest);
    handler.resolve({ reqId: lastReqId(envelopes), decision: { kind: "allow", scope: "session" } });
    await expect(first).resolves.toBe("approved");

    await expect(handler.handleApproval(execRequest)).resolves.toBe("approved");
    // A different command still prompts.
    const other = handler.handleApproval({
      ...execRequest,
      callId: "call_3",
      command: ["rm", "-rf", "x"],
    });
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    handler.resolve({ reqId: lastReqId(envelopes), decision: { kind: "deny" } });
    await other;
  });

  it("remembers 'allow for session' for patch kind generally (no literal to match on)", async () => {
    const { handler, envelopes } = createHandler();

    const first = handler.handleApproval(patchRequest);
    handler.resolve({ reqId: lastReqId(envelopes), decision: { kind: "allow", scope: "session" } });
    await expect(first).resolves.toBe("approved");

    await expect(handler.handleApproval({ ...patchRequest, callId: "call_4" })).resolves.toBe(
      "approved",
    );
  });
});

describe("CodexPermissionHandler resolve()", () => {
  it("is first-wins: a second resolve for the same reqId reports already-answered with the winning decision", async () => {
    const { handler, envelopes } = createHandler();
    const pending = handler.handleApproval(execRequest);
    const reqId = lastReqId(envelopes);

    const first = handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(first).toEqual({ ok: true });

    const second = handler.resolve({ reqId, decision: { kind: "deny" } });
    expect(second).toEqual({
      ok: false,
      reason: "already-answered",
      decision: { kind: "allow", scope: "once" },
    });

    await expect(pending).resolves.toBe("approved");
  });

  it("reports already-answered (no decision) for a totally unknown reqId", () => {
    const { handler } = createHandler();
    expect(handler.resolve({ reqId: "nonexistent", decision: { kind: "deny" } })).toEqual({
      ok: false,
      reason: "already-answered",
    });
  });

  it("a 'mode' decision resolves as approved and switches the active mode", async () => {
    const { handler, envelopes } = createHandler();
    const pending = handler.handleApproval(execRequest);
    const reqId = lastReqId(envelopes);

    handler.resolve({ reqId, decision: { kind: "mode", mode: "bypassPermissions" } });
    await expect(pending).resolves.toBe("approved");
    expect(handler.currentMode).toBe("bypassPermissions");
  });
});

describe("CodexPermissionHandler reset()", () => {
  it("denies every pending approval, clears allow-lists, and resets mode to default", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "bypassPermissions" });
    handler.setMode("default");

    const pending = handler.handleApproval(execRequest);
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");

    handler.reset("Session switched to local mode");

    await expect(pending).resolves.toBe("denied");
    expect(envelopes.at(-1)?.ev).toMatchObject({ t: "perm-resolve" });
    expect(handler.currentMode).toBe("default");

    // Allow-lists cleared: the same exec command prompts again.
    const again = handler.handleApproval(execRequest);
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    handler.resolve({ reqId: lastReqId(envelopes), decision: { kind: "deny" } });
    await again;
  });
});
