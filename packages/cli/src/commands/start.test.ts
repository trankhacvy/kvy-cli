import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import { createEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { FalconCredentials } from "../auth/credentials.js";
import type { LoopDeps, LoopOptions } from "../claude/loop.js";
import type { DaemonState } from "../daemon/state.js";
import type { ClaudeCliLocation } from "../provider/claudeCliLocator.js";
import type { SessionRpcHandlers } from "../rpc/sessionRpc.js";
import type { bootstrapSession as bootstrapSessionType } from "../session/bootstrap.js";
import type { SessionClientHandle } from "../session/sessionClient.js";
import { runStartClaudeCommand, type StartClaudeCommandDeps } from "./start.js";

function fakeCredentials(overrides: Partial<FalconCredentials> = {}): FalconCredentials {
  return {
    token: "test-token",
    masterSecretOrContentBundle: encodeBase64(getRandomBytes(32)),
    ...overrides,
  };
}

function fakeDaemonState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: 1,
    port: 4242,
    version: "0.1.0-test",
    startedAt: 1,
    machineId: "machine-1",
    ...overrides,
  };
}

function fakeClaudeLocation(overrides: Partial<ClaudeCliLocation> = {}): ClaudeCliLocation {
  return { path: "/usr/local/bin/claude", source: "PATH", ...overrides };
}

/** Stands in for `startSessionClient()`'s real return value — a fake `Socket` is enough since nothing here exercises the real socket.io wire protocol (that's `sessionClient.test.ts`'s/`sessionRpc.test.ts`'s job). */
function fakeSessionClientHandle(
  overrides: Partial<SessionClientHandle> = {},
): SessionClientHandle {
  return {
    connected: true,
    socket: { id: "fake-socket" } as unknown as SessionClientHandle["socket"],
    stop: vi.fn(),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<StartClaudeCommandDeps> = {}): StartClaudeCommandDeps {
  const written: string[] = [];
  return {
    homeDir: "/fake/home",
    workingDirectory: "/fake/workdir",
    claudeArgs: [],
    launcherPath: "/fake/launcher.cjs",
    readCredentials: () => fakeCredentials(),
    readDaemonState: async () => fakeDaemonState(),
    locateClaudeCli: () => fakeClaudeLocation(),
    bootstrapSession: vi.fn(async () => ({
      sessionId: "sess_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    })) as unknown as typeof bootstrapSessionType,
    loop: vi.fn(async () => 0),
    // Never open a real socket.io connection from a unit test — same
    // injectable-deps style as every other network-touching dep here
    // (`bootstrapSession`, `fetchImpl`, ...).
    startSessionClient: vi.fn(() => fakeSessionClientHandle()),
    registerSessionRpcHandlers: vi.fn(() => ({ stop: vi.fn() })),
    sleep: async () => {},
    now: () => 0,
    write: (text: string) => {
      written.push(text);
    },
    writeError: (text: string) => {
      written.push(text);
    },
    ...overrides,
  };
}

describe("runStartClaudeCommand", () => {
  it("fails fast with an honest not-logged-in error and never calls loop or the network", async () => {
    const loop = vi.fn(async () => 0);
    const bootstrapSession = vi.fn();
    const stderr: string[] = [];
    const code = await runStartClaudeCommand(
      baseDeps({
        readCredentials: () => null,
        loop,
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not logged in");
    expect(loop).not.toHaveBeenCalled();
    expect(bootstrapSession).not.toHaveBeenCalled();
  });

  it("fails honestly when the claude CLI can't be located", async () => {
    const stderr: string[] = [];
    const code = await runStartClaudeCommand(
      baseDeps({
        locateClaudeCli: () => null,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not installed");
  });

  it("fails honestly when stored credentials aren't a full masterSecret", async () => {
    const stderr: string[] = [];
    const code = await runStartClaudeCommand(
      baseDeps({
        readCredentials: () =>
          fakeCredentials({ masterSecretOrContentBundle: encodeBase64(getRandomBytes(16)) }),
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("reduced-custody");
  });

  it("times out honestly when the daemon never persists a machineId", async () => {
    const stderr: string[] = [];
    let now = 0;
    const code = await runStartClaudeCommand(
      baseDeps({
        readDaemonState: async () => fakeDaemonState({ machineId: undefined }),
        now: () => {
          const value = now;
          now += 1000;
          return value;
        },
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("hasn't finished registering");
  });

  it("surfaces a bootstrapSession failure as an honest error instead of throwing", async () => {
    const stderr: string[] = [];
    const loop = vi.fn(async () => 0);
    const code = await runStartClaudeCommand(
      baseDeps({
        bootstrapSession: vi.fn(async () => {
          throw new Error("server rejected session create");
        }) as unknown as typeof bootstrapSessionType,
        loop,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("failed to start session");
    expect(loop).not.toHaveBeenCalled();
  });

  it("wires bootstrapSession's dek/sessionId + the located claude path into loop() for a fresh local session", async () => {
    const loop = vi.fn(async () => 42);
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_42",
      dek: getRandomBytes(32),
      tag: "tag-42",
      created: true,
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--resume", "abc123"],
        locateClaudeCli: () => fakeClaudeLocation({ path: "/opt/claude/cli.js" }),
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        loop,
      }),
    );

    expect(code).toBe(42);
    expect(bootstrapSession).toHaveBeenCalledOnce();
    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { machineId: string; workspacePath: string; provider: string },
    ];
    expect(bootstrapParams.machineId).toBe("machine-1");
    expect(bootstrapParams.workspacePath).toBe("/fake/workdir");
    expect(bootstrapParams.provider).toBe("claude-code");

    expect(loop).toHaveBeenCalledOnce();
    const [loopOptions, loopDeps] = loop.mock.calls[0] as unknown as [
      {
        workingDirectory: string;
        startingMode: string;
        claudeArgs: string[];
        claudeEnvVars: Record<string, string>;
      },
      { local: { launcherPath: string } },
    ];
    expect(loopOptions.workingDirectory).toBe("/fake/workdir");
    expect(loopOptions.startingMode).toBe("local");
    expect(loopOptions.claudeArgs).toEqual(["--resume", "abc123"]);
    expect(loopOptions.claudeEnvVars).toEqual({ FALCON_CLAUDE_PATH: "/opt/claude/cli.js" });
    expect(loopDeps.local.launcherPath).toBe("/fake/launcher.cjs");
  });

  it("opens the session-scoped socket and registers session RPC handlers keyed by the bootstrapped session, tearing both down when loop() returns", async () => {
    const sessionClientHandle = fakeSessionClientHandle();
    const startSessionClient = vi.fn(() => sessionClientHandle);
    const rpcHandle = { stop: vi.fn() };
    const registerSessionRpcHandlers = vi.fn(() => rpcHandle);
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_rpc",
      dek: getRandomBytes(32),
      tag: "tag-rpc",
      created: true,
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        startSessionClient,
        registerSessionRpcHandlers,
        loop: vi.fn(async () => 0),
      }),
    );

    expect(code).toBe(0);
    expect(startSessionClient).toHaveBeenCalledOnce();
    const [sessionClientDeps] = startSessionClient.mock.calls[0] as unknown as [
      { sessionId: string; token: string },
    ];
    expect(sessionClientDeps.sessionId).toBe("sess_rpc");
    expect(sessionClientDeps.token).toBe("test-token");

    expect(registerSessionRpcHandlers).toHaveBeenCalledOnce();
    const [rpcDeps] = registerSessionRpcHandlers.mock.calls[0] as unknown as [
      { sessionId: string; dek: Uint8Array; socket: unknown; handlers: SessionRpcHandlers },
    ];
    expect(rpcDeps.sessionId).toBe("sess_rpc");
    expect(rpcDeps.socket).toBe(sessionClientHandle.socket);

    // Both torn down once loop() settles — mirrors the existing
    // `outbox.dispose()` `finally` block.
    expect(rpcHandle.stop).toHaveBeenCalledOnce();
    expect(sessionClientHandle.stop).toHaveBeenCalledOnce();
  });

  it("routes a message RPC into loop()'s onMessage subscribers and reports queued/direct-delivery (with tri-state status) honestly by mode", async () => {
    // A real temp homeDir: the message handler now claims (design §7.10)
    // through the on-disk claim store before emitting.
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-start-test-"));
    try {
      // A plain `let` reassigned only from inside the `loop` mock's closure
      // defeats TypeScript's control-flow narrowing at the call site below
      // (it can't see the closure's assignment as reachable) — an object
      // property mutation sidesteps that entirely.
      const modeChangeBag: { onModeChange: ((mode: "local" | "remote") => void) | null } = {
        onModeChange: null,
      };
      const receivedMessages: { id: string; text: string }[] = [];

      const loop = vi.fn(async (options: LoopOptions, loopDeps: LoopDeps) => {
        options.onMessage((message) => receivedMessages.push(message));
        modeChangeBag.onModeChange = options.onModeChange ?? null;
        // `deps.remote` must be a real object, not undefined, since a
        // requested switch calls `startClaudeRemoteLauncher(..., deps.remote)`.
        expect(loopDeps.remote).toBeDefined();
        return 0;
      });

      let capturedHandlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
        capturedHandlers = rpcDeps.handlers;
        return { stop: vi.fn() };
      });

      await runStartClaudeCommand(
        baseDeps({
          homeDir,
          loop,
          registerSessionRpcHandlers,
        }),
      );

      expect(capturedHandlers).not.toBeNull();
      const handlers = capturedHandlers as unknown as SessionRpcHandlers;

      // Still in local mode: the message is queued for delivery via the
      // local→remote switch, not delivered directly. A fresh claim →
      // status 'queued'.
      const envelope = createEnvelope("user", { t: "text", md: "hello from web" });
      const result = await handlers.message({ envelope });
      expect(result).toEqual({ queued: true, status: "queued" });
      expect(receivedMessages).toEqual([{ id: envelope.id, text: "hello from web" }]);

      // A retry of the SAME envelope id — its claim is still open (the turn
      // never settled in this loop mock), so the send is indeterminate: it
      // must NOT re-emit, and reports 'outcome-unknown'.
      const retry = await handlers.message({ envelope });
      expect(retry).toEqual({ queued: false, status: "outcome-unknown" });
      expect(receivedMessages).toHaveLength(1);

      // Once loop() reports a switch to remote, a NEW message is delivered
      // directly (no longer queued), still with a fresh 'queued' status.
      modeChangeBag.onModeChange?.("remote");
      const envelope2 = createEnvelope("user", { t: "text", md: "second message" });
      const result2 = await handlers.message({ envelope: envelope2 });
      expect(result2).toEqual({ queued: false, status: "queued" });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("routes a takeControl RPC into loop()'s onTakeControl subscribers", async () => {
    let takeControlFired = false;
    const loop = vi.fn(async (options: LoopOptions) => {
      options.onTakeControl(() => {
        takeControlFired = true;
      });
      return 0;
    });

    let capturedHandlers: SessionRpcHandlers | null = null;
    const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
      capturedHandlers = rpcDeps.handlers;
      return { stop: vi.fn() };
    });

    await runStartClaudeCommand(baseDeps({ loop, registerSessionRpcHandlers }));

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    const result = await handlers.takeControl();
    expect(result).toEqual({ ok: true });
    expect(takeControlFired).toBe(true);
  });

  it("answers interrupt/setMode/perm.answer honestly as not-yet-supported rather than faking success", async () => {
    let capturedHandlers: SessionRpcHandlers | null = null;
    const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
      capturedHandlers = rpcDeps.handlers;
      return { stop: vi.fn() };
    });

    await runStartClaudeCommand(
      baseDeps({ loop: vi.fn(async () => 0), registerSessionRpcHandlers }),
    );

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    await expect(handlers.interrupt()).resolves.toEqual({ ok: false });
    await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({ ok: false });
    await expect(
      handlers.permAnswer({ reqId: "req_1", decision: { kind: "deny" } }),
    ).resolves.toEqual({ ok: false });
  });
});
