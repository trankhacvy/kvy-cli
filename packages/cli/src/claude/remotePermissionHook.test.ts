import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { HookServerDeps, HookServerHandle, HookSettingsFile } from "./hookServer.js";
import type { PreToolUseHookInput, PreToolUseHookOutput } from "./pretoolPermissionBridge.js";
import { HOOK_SETTINGS_ENV_VAR, installRemotePermissionHook } from "./remotePermissionHook.js";

/**
 * Fakes for the two injected seams — no real Fastify server / temp files. The
 * fake `startHookServer` captures the deps so a test can drive `onPreToolUse`
 * / `onAttention` directly, exercising the REAL bridge underneath.
 */
function makeHarness() {
  const emitted: SessionEnvelope[] = [];
  let captured: HookServerDeps | null = null;
  const serverStop = vi.fn(async () => {});
  const cleanup = vi.fn();

  const startHookServer = vi.fn(async (deps: HookServerDeps): Promise<HookServerHandle> => {
    captured = deps;
    return { port: 45678, stop: serverStop };
  });
  const writeHookSettingsFile = vi.fn(
    (_dir: string, _port: number): HookSettingsFile => ({
      path: "/tmp/hooks/session-hook-x.json",
      cleanup,
    }),
  );

  return {
    emitted,
    serverStop,
    cleanup,
    startHookServer,
    writeHookSettingsFile,
    get captured(): HookServerDeps {
      if (!captured) throw new Error("hook server not started");
      return captured;
    },
    install: () =>
      installRemotePermissionHook(
        { hooksDir: "/tmp/hooks", emitEnvelope: (e) => emitted.push(e) },
        { startHookServer, writeHookSettingsFile },
      ),
  };
}

const preTool = (
  tool_name: string,
  tool_input: Record<string, unknown> = {},
): PreToolUseHookInput => ({
  tool_name,
  tool_input,
});

function permRequestId(emitted: SessionEnvelope[]): string {
  const req = emitted.find((e) => e.ev.t === "perm-request");
  if (req?.ev.t !== "perm-request") throw new Error("no perm-request emitted");
  return req.ev.reqId;
}

describe("installRemotePermissionHook", () => {
  it("exposes the settings path via env var and the resolved loopback port", async () => {
    const h = makeHarness();
    const handle = await h.install();

    expect(handle.port).toBe(45678);
    expect(handle.settingsPath).toBe("/tmp/hooks/session-hook-x.json");
    expect(handle.settingsEnv).toEqual({
      [HOOK_SETTINGS_ENV_VAR]: "/tmp/hooks/session-hook-x.json",
    });
    expect(h.writeHookSettingsFile).toHaveBeenCalledWith("/tmp/hooks", 45678);

    await handle.stop();
  });

  it("defers to the terminal (`ask`) until a web turn is marked active", async () => {
    const h = makeHarness();
    const handle = await h.install();

    const before = (await h.captured.onPreToolUse?.(preTool("Bash"))) as PreToolUseHookOutput;
    expect(before.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(handle.isWebTurnActive()).toBe(false);

    handle.markWebTurnStart();
    expect(handle.isWebTurnActive()).toBe(true);

    await handle.stop();
  });

  it("routes a web-turn tool call through the bridge and resolves it via perm.answer", async () => {
    const h = makeHarness();
    const handle = await h.install();
    handle.markWebTurnStart();

    const pending = h.captured.onPreToolUse?.(preTool("Bash", { command: "ls" }));
    const reqId = permRequestId(h.emitted);

    const result = handle.resolvePermission({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(result).toEqual({ ok: true });

    const output = (await pending) as PreToolUseHookOutput;
    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");

    await handle.stop();
  });

  it("ends the web turn when Claude Code's Stop hook fires (attention 'done')", async () => {
    const h = makeHarness();
    const handle = await h.install();
    handle.markWebTurnStart();
    expect(handle.isWebTurnActive()).toBe(true);

    h.captured.onAttention?.("done");
    expect(handle.isWebTurnActive()).toBe(false);

    await handle.stop();
  });

  it("forwards SessionStart/attention hooks to the caller's callbacks", async () => {
    const onSessionId = vi.fn();
    const onAttention = vi.fn();
    const h = makeHarness();
    const handle = await installRemotePermissionHook(
      {
        hooksDir: "/tmp/hooks",
        emitEnvelope: (e) => h.emitted.push(e),
        onSessionId,
        onAttention,
      },
      { startHookServer: h.startHookServer, writeHookSettingsFile: h.writeHookSettingsFile },
    );

    h.captured.onSessionId("uuid-1");
    h.captured.onAttention?.("perm");
    expect(onSessionId).toHaveBeenCalledWith("uuid-1");
    expect(onAttention).toHaveBeenCalledWith("perm");

    await handle.stop();
  });

  it("stop() cleans up the settings file, stops the server, and denies dangling requests", async () => {
    const h = makeHarness();
    const handle = await h.install();
    handle.markWebTurnStart();

    const pending = h.captured.onPreToolUse?.(preTool("Bash"));
    await handle.stop();

    const output = (await pending) as PreToolUseHookOutput;
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.serverStop).toHaveBeenCalledOnce();
  });
});
