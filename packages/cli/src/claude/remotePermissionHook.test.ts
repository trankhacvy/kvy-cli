import type { SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { HookServerDeps, HookServerHandle, HookSettingsFile } from "./hookServer.js";
import type {
  PermissionRequestHookInput,
  PermissionRequestHookOutput,
  PreToolUseHookInput,
  PreToolUseHookOutput,
} from "./pretoolPermissionBridge.js";
import {
  HOOK_SETTINGS_ENV_VAR,
  installRemotePermissionHook,
  WEB_TURN_MAX_MS,
} from "./remotePermissionHook.js";

/**
 * Fakes for the two injected seams — no real Fastify server / temp files. The
 * fake `startHookServer` captures the deps so a test can drive
 * `onPreToolUse`/`onPermissionRequest`/`onAttention` directly, exercising the
 * REAL bridge underneath.
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
    install: (
      optsOverrides: Partial<Parameters<typeof installRemotePermissionHook>[0]> = {},
      depsOverrides: Partial<Parameters<typeof installRemotePermissionHook>[1]> = {},
    ) =>
      installRemotePermissionHook(
        {
          hooksDir: "/tmp/hooks",
          emitEnvelope: (e) => emitted.push(e),
          ...optsOverrides,
        },
        { startHookServer, writeHookSettingsFile, ...depsOverrides },
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

const permReq = (
  tool_name: string,
  tool_input: Record<string, unknown> = {},
): PermissionRequestHookInput => ({
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

  it("onPreToolUse always defers to `ask`, regardless of web-turn state", async () => {
    const h = makeHarness();
    const handle = await h.install();

    const before = (await h.captured.onPreToolUse?.(preTool("Bash"))) as PreToolUseHookOutput;
    expect(before.hookSpecificOutput.permissionDecision).toBe("ask");

    handle.markWebTurnStart();
    const after = (await h.captured.onPreToolUse?.(preTool("Bash"))) as PreToolUseHookOutput;
    expect(after.hookSpecificOutput.permissionDecision).toBe("ask");

    await handle.stop();
  });

  it("onPermissionRequest defers to the terminal (undefined) until a web turn is marked active", async () => {
    const h = makeHarness();
    const handle = await h.install();

    const before = await h.captured.onPermissionRequest?.(permReq("Bash"));
    expect(before).toBeUndefined();
    expect(handle.isWebTurnActive()).toBe(false);

    handle.markWebTurnStart();
    expect(handle.isWebTurnActive()).toBe(true);

    await handle.stop();
  });

  it("routes a web-turn PermissionRequest through the bridge and resolves it via perm.answer", async () => {
    const h = makeHarness();
    const handle = await h.install();
    handle.markWebTurnStart();

    const pending = h.captured.onPermissionRequest?.(permReq("Bash", { command: "ls" }));
    const reqId = permRequestId(h.emitted);

    const result = handle.resolvePermission({ reqId, decision: { kind: "allow", scope: "once" } });
    expect(result).toEqual({ ok: true });

    const output = (await pending) as PermissionRequestHookOutput;
    expect(output.hookSpecificOutput.decision?.behavior).toBe("allow");

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

  it("stop() cleans up the settings file, stops the server, and denies dangling PermissionRequests", async () => {
    const h = makeHarness();
    const handle = await h.install();
    handle.markWebTurnStart();

    const pending = h.captured.onPermissionRequest?.(permReq("Bash"));
    await handle.stop();

    const output = (await pending) as PermissionRequestHookOutput;
    expect(output.hookSpecificOutput.decision?.behavior).toBe("deny");
    expect(h.cleanup).toHaveBeenCalledOnce();
    expect(h.serverStop).toHaveBeenCalledOnce();
  });

  describe("web-turn watchdog + local-activity override (W1.2)", () => {
    it("auto-clears a web turn quiet past webTurnMaxMs", async () => {
      let clock = 0;
      const h = makeHarness();
      const handle = await h.install({ webTurnMaxMs: 1000 }, { now: () => clock });

      handle.markWebTurnStart();
      expect(handle.isWebTurnActive()).toBe(true);

      clock += 1001;
      expect(handle.isWebTurnActive()).toBe(false);

      await handle.stop();
    });

    it("defaults to WEB_TURN_MAX_MS (30 minutes) when webTurnMaxMs is not overridden", async () => {
      let clock = 0;
      const h = makeHarness();
      const handle = await h.install({}, { now: () => clock });

      handle.markWebTurnStart();
      // Note: `isWebTurnActive()` itself refreshes the last-activity clock
      // while still active (that's the point — hook traffic counts as
      // activity), so this test checks expiry from a single jump past the
      // default max rather than an incremental countdown that would keep
      // refreshing itself.
      clock += WEB_TURN_MAX_MS + 1;
      expect(handle.isWebTurnActive()).toBe(false);

      await handle.stop();
    });

    it("hook traffic while active refreshes the watchdog's last-activity clock", async () => {
      let clock = 0;
      const h = makeHarness();
      const handle = await h.install({ webTurnMaxMs: 1000 }, { now: () => clock });
      handle.markWebTurnStart();

      // A PermissionRequest firing partway through calls isWebTurnActive(),
      // which refreshes the clock — so the flag survives past the ORIGINAL
      // deadline as long as it keeps seeing activity.
      clock += 600;
      void h.captured.onPermissionRequest?.(permReq("Bash"));
      clock += 600; // would have expired from turn-start, but not from the refresh
      expect(handle.isWebTurnActive()).toBe(true);

      await handle.stop();
    });

    it("markLocalActivity clears an active web turn immediately, regardless of the watchdog", async () => {
      const h = makeHarness();
      const handle = await h.install();
      handle.markWebTurnStart();
      expect(handle.isWebTurnActive()).toBe(true);

      handle.markLocalActivity();
      expect(handle.isWebTurnActive()).toBe(false);

      await handle.stop();
    });
  });

  describe("onPromptLikely forwarding (W1.3)", () => {
    it("forwards the bridge's local-turn onPromptLikely signal to the caller", async () => {
      const onPromptLikely = vi.fn();
      const h = makeHarness();
      const handle = await h.install({ onPromptLikely });

      // Local turn (never marked as web) — both hooks' local paths fire it.
      await h.captured.onPreToolUse?.(preTool("Bash"));
      expect(onPromptLikely).toHaveBeenCalledOnce();

      await h.captured.onPermissionRequest?.(permReq("Bash"));
      expect(onPromptLikely).toHaveBeenCalledTimes(2);

      await handle.stop();
    });

    it("never fires onPromptLikely on the web-turn path", async () => {
      const onPromptLikely = vi.fn();
      const h = makeHarness();
      const handle = await h.install({ onPromptLikely });
      handle.markWebTurnStart();

      await h.captured.onPreToolUse?.(preTool("Bash"));
      void h.captured.onPermissionRequest?.(permReq("Bash"));
      expect(onPromptLikely).not.toHaveBeenCalled();

      await handle.stop();
    });
  });

  describe("permission_mode cache forwarding (W4.3 — real PTY setMode)", () => {
    it("getCurrentPermissionMode is null before any hook fires, then reflects the latest permission_mode", async () => {
      const h = makeHarness();
      const handle = await h.install();
      expect(handle.getCurrentPermissionMode()).toBeNull();

      await h.captured.onPreToolUse?.({ tool_name: "Bash", permission_mode: "acceptEdits" });
      expect(handle.getCurrentPermissionMode()).toBe("acceptEdits");

      await h.captured.onPermissionRequest?.({ tool_name: "Bash", permission_mode: "plan" });
      expect(handle.getCurrentPermissionMode()).toBe("plan");

      await handle.stop();
    });

    it("waitForModeEcho resolves with the mode observed on the next hook input", async () => {
      const h = makeHarness();
      const handle = await h.install();

      const echo = handle.waitForModeEcho(5000);
      await h.captured.onPreToolUse?.({ tool_name: "Bash", permission_mode: "bypassPermissions" });
      await expect(echo).resolves.toBe("bypassPermissions");

      await handle.stop();
    });
  });
});
