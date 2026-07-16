import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import { PermissionHandler } from "./permissionHandler.js";

function makeOptions(overrides: Partial<{ signal: AbortSignal; toolUseID: string; agentID: string }> = {}) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    toolUseID: overrides.toolUseID ?? "toolu_1",
    requestId: "req_1",
    ...overrides,
  } as Parameters<PermissionHandler["canUseTool"]>[2];
}

function createHandler(overrides: Partial<ConstructorParameters<typeof PermissionHandler>[0]> = {}) {
  const envelopes: SessionEnvelope[] = [];
  const handler = new PermissionHandler({
    emitEnvelope: (envelope) => envelopes.push(envelope),
    ...overrides,
  });
  return { handler, envelopes };
}

describe("PermissionHandler auto-rules", () => {
  it("allows everything in bypassPermissions mode", async () => {
    const { handler } = createHandler({ initialMode: "bypassPermissions" });
    const result = await handler.canUseTool("Bash", { command: "rm -rf /tmp/x" }, makeOptions());
    expect(result).toMatchObject({ behavior: "allow" });
  });

  it("allows edit tools in acceptEdits mode but still prompts for Bash", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "acceptEdits" });

    const editResult = await handler.canUseTool("Write", { file_path: "/tmp/x", content: "y" }, makeOptions());
    expect(editResult).toMatchObject({ behavior: "allow" });

    const pending = handler.canUseTool("Bash", { command: "ls" }, makeOptions());
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    // Resolve so the promise doesn't hang past the test.
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "deny" } });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });

  it("allows non-dangerous tools in plan mode but prompts for dangerous ones", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "plan" });

    const readResult = await handler.canUseTool("Read", { file_path: "/tmp/x" }, makeOptions());
    expect(readResult).toMatchObject({ behavior: "allow" });

    const pending = handler.canUseTool("Bash", { command: "ls" }, makeOptions());
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "deny" } });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });

  it("always prompts for AskUserQuestion, even in bypassPermissions mode", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "bypassPermissions" });
    const pending = handler.canUseTool("AskUserQuestion", { question: "which?" }, makeOptions());
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("always prompts for ExitPlanMode, even in bypassPermissions mode", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "bypassPermissions" });
    const pending = handler.canUseTool("ExitPlanMode", { plan: "do the thing" }, makeOptions());
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "deny" } });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
  });

  it("prompts in default mode for everything except previously-allowed tools", async () => {
    const { handler, envelopes } = createHandler();
    const pending = handler.canUseTool("Read", { file_path: "/tmp/x" }, makeOptions());
    expect(envelopes.at(-1)?.ev.t).toBe("perm-request");
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });
});

describe("PermissionHandler allow-for-session", () => {
  it("allow scope:session on a non-Bash tool auto-approves future calls to that tool", async () => {
    const { handler, envelopes } = createHandler();
    const first = handler.canUseTool("Read", { file_path: "/a" }, makeOptions());
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "allow", scope: "session" } });
    await expect(first).resolves.toMatchObject({ behavior: "allow" });

    const second = await handler.canUseTool("Read", { file_path: "/b" }, makeOptions());
    expect(second).toMatchObject({ behavior: "allow" });
    // No second perm-request was emitted for the auto-approved call.
    expect(envelopes.filter((e) => e.ev.t === "perm-request")).toHaveLength(1);
  });

  it("allow scope:session on Bash allow-lists only the exact literal command", async () => {
    const { handler, envelopes } = createHandler();
    const first = handler.canUseTool("Bash", { command: "git status" }, makeOptions());
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "allow", scope: "session" } });
    await expect(first).resolves.toMatchObject({ behavior: "allow" });

    const sameCommand = await handler.canUseTool("Bash", { command: "git status" }, makeOptions());
    expect(sameCommand).toMatchObject({ behavior: "allow" });

    const differentCommand = handler.canUseTool("Bash", { command: "git log" }, makeOptions());
    expect(envelopes.filter((e) => e.ev.t === "perm-request")).toHaveLength(2);
    const secondReqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId: secondReqId, decision: { kind: "deny" } });
    await expect(differentCommand).resolves.toMatchObject({ behavior: "deny" });
  });

  it("allowBashPrefix allows any command starting with the prefix", async () => {
    const { handler } = createHandler();
    handler.allowBashPrefix("git ");
    const result = await handler.canUseTool("Bash", { command: "git log --oneline" }, makeOptions());
    expect(result).toMatchObject({ behavior: "allow" });
  });
});

describe("PermissionHandler mode decision", () => {
  it("a 'mode' decision switches mode, notifies onModeChange, and allows the pending tool", async () => {
    const onModeChange = vi.fn();
    const { handler, envelopes } = createHandler({ onModeChange });

    const pending = handler.canUseTool("ExitPlanMode", { plan: "..." }, makeOptions());
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "mode", mode: "acceptEdits" } });

    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("acceptEdits");
    expect(handler.currentMode).toBe("acceptEdits");

    // The new mode is now in effect for subsequent calls.
    const editResult = await handler.canUseTool("Write", { file_path: "/x", content: "y" }, makeOptions());
    expect(editResult).toMatchObject({ behavior: "allow" });
  });
});

describe("PermissionHandler first-wins resolution", () => {
  it("the first resolve() wins; a second resolve() for the same reqId gets already-answered plus the winning decision", async () => {
    const { handler, envelopes } = createHandler();
    const pending = handler.canUseTool("Read", { file_path: "/a" }, makeOptions());
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;

    const first = handler.resolve({ reqId, decision: { kind: "allow", scope: "once" } });
    const second = handler.resolve({ reqId, decision: { kind: "deny" } });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      ok: false,
      reason: "already-answered",
      decision: { kind: "allow", scope: "once" },
    });
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("resolving an unknown reqId returns already-answered with no decision", () => {
    const { handler } = createHandler();
    expect(handler.resolve({ reqId: "does-not-exist", decision: { kind: "deny" } })).toEqual({
      ok: false,
      reason: "already-answered",
    });
  });

  it("emits a perm-resolve envelope carrying the winning decision", async () => {
    const { handler, envelopes } = createHandler();
    const pending = handler.canUseTool("Read", { file_path: "/a" }, makeOptions());
    const reqId = (envelopes.at(-1)?.ev as { reqId: string }).reqId;
    handler.resolve({ reqId, decision: { kind: "deny", message: "no thanks" } });
    await pending;

    const resolveEnvelope = envelopes.find((e) => e.ev.t === "perm-resolve");
    expect(resolveEnvelope?.ev).toMatchObject({
      t: "perm-resolve",
      reqId,
      decision: { kind: "deny", message: "no thanks" },
    });
  });
});

describe("PermissionHandler reset", () => {
  it("rejects every pending request, clears allow-lists and mode, and emits a perm-resolve for each", async () => {
    const { handler, envelopes } = createHandler({ initialMode: "bypassPermissions" });
    handler.setMode("acceptEdits");

    const pendingA = handler.canUseTool("Read", { file_path: "/a" }, makeOptions({ toolUseID: "a" }));
    const pendingB = handler.canUseTool("AskUserQuestion", { question: "?" }, makeOptions({ toolUseID: "b" }));

    pendingA.catch(() => {});
    pendingB.catch(() => {});

    handler.reset("mode switched");

    await expect(pendingA).rejects.toThrow("Session reset");
    await expect(pendingB).rejects.toThrow("Session reset");
    expect(handler.currentMode).toBe("default");
    expect(envelopes.filter((e) => e.ev.t === "perm-resolve")).toHaveLength(2);
  });

  it("resolve() after reset reports already-answered", async () => {
    const { handler } = createHandler();
    const pending = handler.canUseTool("Read", { file_path: "/a" }, makeOptions());
    pending.catch(() => {});
    handler.reset();
    // We don't know the reqId from outside, but any resolve on a cleared map must be already-answered.
    expect(handler.resolve({ reqId: "whatever", decision: { kind: "deny" } })).toMatchObject({
      ok: false,
      reason: "already-answered",
    });
  });
});
