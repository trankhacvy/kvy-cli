import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import { createEnvelope } from "@falcon/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FalconCredentials } from "../auth/credentials.js";
import type { LoopOptions } from "../claude/loop.js";
import type {
  PtyClaudeSessionHandle,
  PtyClaudeSessionOptions,
} from "../claude/ptyClaudeSession.js";
import type {
  installRemotePermissionHook as installRemotePermissionHookType,
  RemotePermissionHookHandle,
} from "../claude/remotePermissionHook.js";
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

/** A fake PTY-injection session handle whose `done` resolves with an exit code. */
function fakePtyHandle(overrides: Partial<PtyClaudeSessionHandle> = {}): PtyClaudeSessionHandle {
  return {
    done: Promise.resolve(0),
    injectMessage: vi.fn(),
    notifyProviderSessionId: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

/**
 * Stands in for `installRemotePermissionHook()` — a unit test must never
 * start a real loopback Fastify hook server or write files under the fake
 * homeDir. Defaults keep the terminal-flow assertions honest: `settingsEnv`
 * is empty and `resolvePermission` reports the not-answered shape.
 */
function fakeRemotePermissionHook(
  overrides: Partial<RemotePermissionHookHandle> = {},
): RemotePermissionHookHandle {
  return {
    settingsPath: "/fake/home/tmp/hooks/session-hook-test.json",
    settingsEnv: {},
    port: 12345,
    resolvePermission: () => ({ ok: false }),
    isWebTurnActive: () => false,
    markWebTurnStart: () => {},
    markTurnEnd: () => {},
    stop: vi.fn(async () => {}),
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
    // The terminal-attached (default) flow uses the PTY session, never loop.
    startPtyClaudeSession: vi.fn(() => fakePtyHandle()),
    // Never start a real loopback hook server from a unit test.
    installRemotePermissionHook: (async () =>
      fakeRemotePermissionHook()) as unknown as typeof installRemotePermissionHookType,
    loop: vi.fn(async () => 0),
    startSessionClient: vi.fn(() => fakeSessionClientHandle()),
    registerSessionRpcHandlers: vi.fn(() => ({ stop: vi.fn() })),
    // Never let a unit test hit the real backend for a lifecycle-status
    // report (W1.4) — same "no real network from a unit test" rule every
    // other injected dep here already follows.
    reportSessionStatus: vi.fn(async () => ({ type: "ok" }) as const),
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

describe("runStartClaudeCommand — preflight", () => {
  it("fails fast with an honest not-logged-in error and never spawns anything", async () => {
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());
    const bootstrapSession = vi.fn();
    const stderr: string[] = [];
    const code = await runStartClaudeCommand(
      baseDeps({
        readCredentials: () => null,
        startPtyClaudeSession,
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("not logged in");
    expect(startPtyClaudeSession).not.toHaveBeenCalled();
    expect(bootstrapSession).not.toHaveBeenCalled();
  });

  it("fails honestly when the claude CLI can't be located", async () => {
    const stderr: string[] = [];
    const code = await runStartClaudeCommand(
      baseDeps({ locateClaudeCli: () => null, writeError: (text) => stderr.push(text) }),
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
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());
    const code = await runStartClaudeCommand(
      baseDeps({
        bootstrapSession: vi.fn(async () => {
          throw new Error("server rejected session create");
        }) as unknown as typeof bootstrapSessionType,
        startPtyClaudeSession,
        writeError: (text) => stderr.push(text),
      }),
    );
    expect(code).toBe(1);
    expect(stderr.join("")).toContain("failed to start session");
    expect(startPtyClaudeSession).not.toHaveBeenCalled();
  });
});

describe("runStartClaudeCommand — terminal (PTY) flow", () => {
  it("wires the located claude path, launcher, workdir and args into the PTY session and returns its exit code", async () => {
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ done: Promise.resolve(42) }));
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_42",
      dek: getRandomBytes(32),
      tag: "tag-42",
      created: true,
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--model", "opus"],
        locateClaudeCli: () => fakeClaudeLocation({ path: "/opt/claude/cli.js" }),
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        startPtyClaudeSession,
        loop: vi.fn(async () => 0),
      }),
    );

    expect(code).toBe(42);
    expect(startPtyClaudeSession).toHaveBeenCalledOnce();
    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    expect(ptyOptions.workingDirectory).toBe("/fake/workdir");
    expect(ptyOptions.launcherPath).toBe("/fake/launcher.cjs");
    expect(ptyOptions.claudeCliPath).toBe("/opt/claude/cli.js");
    expect(ptyOptions.claudeArgs).toEqual(["--model", "opus"]);
    expect(ptyOptions.providerSessionId).toBeNull();
  });

  it("installs exactly one hook server and hands its settings path/env to the PTY session", async () => {
    const installRemotePermissionHook = vi.fn(async () =>
      fakeRemotePermissionHook({
        settingsPath: "/tmp/hooks/s.json",
        settingsEnv: { FALCON_HOOK_SETTINGS_PATH: "/tmp/hooks/s.json" },
      }),
    );
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());

    await runStartClaudeCommand(
      baseDeps({
        installRemotePermissionHook:
          installRemotePermissionHook as unknown as typeof installRemotePermissionHookType,
        startPtyClaudeSession,
      }),
    );

    // Exactly ONE hook server for the whole terminal flow.
    expect(installRemotePermissionHook).toHaveBeenCalledOnce();
    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    expect(ptyOptions.settingsPath).toBe("/tmp/hooks/s.json");
    expect(ptyOptions.settingsEnv).toEqual({ FALCON_HOOK_SETTINGS_PATH: "/tmp/hooks/s.json" });
  });

  it("never touches the mode loop for a terminal session", async () => {
    const loop = vi.fn(async () => 0);
    await runStartClaudeCommand(baseDeps({ loop }));
    expect(loop).not.toHaveBeenCalled();
  });

  it("opens the session socket + registers RPCs, tearing the RPCs, session client, PTY session and hook down when it ends", async () => {
    const sessionClientHandle = fakeSessionClientHandle();
    const startSessionClient = vi.fn(() => sessionClientHandle);
    const rpcHandle = { stop: vi.fn() };
    const registerSessionRpcHandlers = vi.fn(() => rpcHandle);
    const ptyStop = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ stop: ptyStop }));
    const hookStop = vi.fn(async () => {});
    const installRemotePermissionHook = (async () =>
      fakeRemotePermissionHook({
        stop: hookStop,
      })) as unknown as typeof installRemotePermissionHookType;

    const code = await runStartClaudeCommand(
      baseDeps({
        startSessionClient,
        registerSessionRpcHandlers,
        startPtyClaudeSession,
        installRemotePermissionHook,
      }),
    );

    expect(code).toBe(0);
    expect(startSessionClient).toHaveBeenCalledOnce();
    expect(registerSessionRpcHandlers).toHaveBeenCalledOnce();
    const [rpcDeps] = registerSessionRpcHandlers.mock.calls[0] as unknown as [
      { sessionId: string; socket: unknown; handlers: SessionRpcHandlers },
    ];
    expect(rpcDeps.sessionId).toBe("sess_1");
    expect(rpcDeps.socket).toBe(sessionClientHandle.socket);

    expect(rpcHandle.stop).toHaveBeenCalledOnce();
    expect(sessionClientHandle.stop).toHaveBeenCalledOnce();
    expect(ptyStop).toHaveBeenCalledOnce();
    expect(hookStop).toHaveBeenCalledOnce();
  });

  it("routes the hook server's SessionStart provider session id into the PTY tailer", async () => {
    const notifyProviderSessionId = vi.fn();
    let onSessionId: ((id: string) => void) | undefined;
    const installRemotePermissionHook = (async (opts: { onSessionId?: (id: string) => void }) => {
      onSessionId = opts.onSessionId;
      return fakeRemotePermissionHook();
    }) as unknown as typeof installRemotePermissionHookType;
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ notifyProviderSessionId }));

    await runStartClaudeCommand(baseDeps({ installRemotePermissionHook, startPtyClaudeSession }));

    onSessionId?.("11111111-2222-3333-4444-555555555555");
    expect(notifyProviderSessionId).toHaveBeenCalledExactlyOnceWith(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("injects a message RPC into the PTY and completes the send claim once the message is submitted", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-start-test-"));
    try {
      const injectMessage = vi.fn();
      let onInjected: ((id: string) => void) | undefined;
      const startPtyClaudeSession = vi.fn((opts: PtyClaudeSessionOptions) => {
        onInjected = opts.onInjected;
        return fakePtyHandle({ injectMessage });
      });

      let capturedHandlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
        capturedHandlers = rpcDeps.handlers;
        return { stop: vi.fn() };
      });

      await runStartClaudeCommand(
        baseDeps({ homeDir, startPtyClaudeSession, registerSessionRpcHandlers }),
      );

      const handlers = capturedHandlers as unknown as SessionRpcHandlers;

      // A fresh send is claimed and typed into the PTY.
      const envelope = createEnvelope("user", { t: "text", md: "hello from web" });
      const result = await handlers.message({ envelope });
      expect(result).toEqual({ queued: true, status: "queued" });
      expect(injectMessage).toHaveBeenCalledExactlyOnceWith({
        id: envelope.id,
        text: "hello from web",
      });

      // A retry BEFORE the message is submitted is indeterminate — not re-injected.
      const retry = await handlers.message({ envelope });
      expect(retry).toEqual({ queued: false, status: "outcome-unknown" });
      expect(injectMessage).toHaveBeenCalledOnce();

      // Once the PTY session reports the message was submitted, the claim
      // completes — a later retry is an honest duplicate.
      onInjected?.(envelope.id);
      await vi.waitFor(async () => {
        const dup = await handlers.message({ envelope });
        expect(dup).toEqual({ queued: false, status: "duplicate" });
      });
      expect(injectMessage).toHaveBeenCalledOnce();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("marks the turn web-initiated when a message is submitted into the PTY", async () => {
    let webTurnStarts = 0;
    let onInjected: ((id: string) => void) | undefined;
    const startPtyClaudeSession = vi.fn((opts: PtyClaudeSessionOptions) => {
      onInjected = opts.onInjected;
      return fakePtyHandle();
    });
    const installRemotePermissionHook = (async () =>
      fakeRemotePermissionHook({
        markWebTurnStart: () => {
          webTurnStarts += 1;
        },
      })) as unknown as typeof installRemotePermissionHookType;

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, installRemotePermissionHook }));

    // The web turn is marked the moment the PTY reports the message submitted —
    // so THIS turn's PreToolUse prompts route to the web PermCard.
    expect(webTurnStarts).toBe(0);
    onInjected?.("m1");
    expect(webTurnStarts).toBe(1);
  });

  it("answers takeControl as a no-op success, interrupt/setMode as not-supported, and routes perm.answer into the hook bridge", async () => {
    const resolvePermission = vi.fn(() => ({ ok: true as const }));
    const installRemotePermissionHook = (async () =>
      fakeRemotePermissionHook({
        resolvePermission,
      })) as unknown as typeof installRemotePermissionHookType;

    let capturedHandlers: SessionRpcHandlers | null = null;
    const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
      capturedHandlers = rpcDeps.handlers;
      return { stop: vi.fn() };
    });

    await runStartClaudeCommand(
      baseDeps({ registerSessionRpcHandlers, installRemotePermissionHook }),
    );

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    await expect(handlers.takeControl()).resolves.toEqual({ ok: true });
    await expect(handlers.interrupt()).resolves.toEqual({ ok: false });
    await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({ ok: false });

    // perm.answer routes to the PreToolUse bridge (first-wins), not {ok:false}.
    const result = await handlers.permAnswer({
      reqId: "req_1",
      decision: { kind: "allow", scope: "once" },
    });
    expect(result).toEqual({ ok: true });
    expect(resolvePermission).toHaveBeenCalledExactlyOnceWith({
      reqId: "req_1",
      decision: { kind: "allow", scope: "once" },
    });
  });

  it("reports the session 'ended' with no error on a clean (code 0) exit", async () => {
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ done: Promise.resolve(0) }));

    const code = await runStartClaudeCommand(
      baseDeps({ startPtyClaudeSession, reportSessionStatus }),
    );

    expect(code).toBe(0);
    expect(reportSessionStatus).toHaveBeenCalledOnce();
    const [reportDeps, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      { accessToken: string },
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportDeps.accessToken).toBe("test-token");
    expect(reportParams).toEqual({ sessionId: "sess_1", status: "ended", error: undefined });
  });

  it("reports the session 'failed' with the exit code in the error on a non-zero exit", async () => {
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ done: Promise.resolve(7) }));

    const code = await runStartClaudeCommand(
      baseDeps({ startPtyClaudeSession, reportSessionStatus }),
    );

    expect(code).toBe(7);
    expect(reportSessionStatus).toHaveBeenCalledOnce();
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams.sessionId).toBe("sess_1");
    expect(reportParams.status).toBe("failed");
    expect(reportParams.error?.message).toBe("claude exited with code 7");
  });

  it("still starts (non-fatally) with no --settings and not-supported perm.answer when the hook fails to install", async () => {
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());
    let capturedHandlers: SessionRpcHandlers | null = null;
    const code = await runStartClaudeCommand(
      baseDeps({
        installRemotePermissionHook: (async () => {
          throw new Error("port in use");
        }) as unknown as typeof installRemotePermissionHookType,
        startPtyClaudeSession,
        registerSessionRpcHandlers: vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
          capturedHandlers = rpcDeps.handlers;
          return { stop: vi.fn() };
        }),
      }),
    );

    expect(code).toBe(0);
    expect(startPtyClaudeSession).toHaveBeenCalledOnce();
    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    // The PTY session got no hook settings path (session runs without hooks).
    expect(ptyOptions.settingsPath).toBeNull();

    // With no hook installed, perm.answer is honestly not-supported again.
    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    await expect(handlers.permAnswer({ reqId: "x", decision: { kind: "deny" } })).resolves.toEqual({
      ok: false,
    });
  });
});

describe("runStartClaudeCommand — daemon-spawned remote flow (--starting-mode remote)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
  });

  it("gracefully requests loop() exit on SIGTERM (via onExitRequested) instead of calling process.exit directly", async () => {
    const rpcStop = vi.fn();
    const registerSessionRpcHandlers = vi.fn(() => ({ stop: rpcStop }));
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
    // A real `loop()` resolves once `onExitRequested`'s handler fires (see
    // `loop.ts`'s `unsubscribeExit`/`activeRemote.requestExit()`) — faking
    // that same shape here proves `runRemoteLoop` wires the signal into a
    // real, subscribable `onExitRequested` rather than the old no-op stub.
    const loop = vi.fn(
      async (options: LoopOptions) =>
        await new Promise<number>((resolve) => {
          options.onExitRequested(() => resolve(0));
        }),
    );
    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const resultPromise = runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--starting-mode", "remote"],
        loop,
        registerSessionRpcHandlers,
        reportSessionStatus,
      }),
    );

    await vi.waitFor(() => {
      expect(onSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true);
    });
    const sigtermCall = onSpy.mock.calls.find(([event]) => event === "SIGTERM");
    const handler = sigtermCall?.[1] as ((signal: NodeJS.Signals) => void) | undefined;
    expect(handler).toBeDefined();

    handler?.("SIGTERM");

    const code = await resultPromise;

    expect(code).toBe(0);
    // The loop's own `finally { rpcHandle.stop(); }` ran — proof the signal
    // didn't short-circuit past `runRemoteLoop`'s cleanup either.
    expect(rpcStop).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    expect(reportSessionStatus).toHaveBeenCalledTimes(1);
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams).toEqual({ sessionId: "sess_1", status: "ended", error: undefined });
  });

  it("keeps the headless mode loop (never the PTY or a hook server) and starts it in remote mode", async () => {
    const loop = vi.fn(async (options: LoopOptions) => {
      expect(options.startingMode).toBe("remote");
      return 5;
    });
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());
    const installRemotePermissionHook = vi.fn(async () => fakeRemotePermissionHook());
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--starting-mode", "remote", "--started-by", "daemon"],
        loop,
        startPtyClaudeSession,
        installRemotePermissionHook:
          installRemotePermissionHook as unknown as typeof installRemotePermissionHookType,
        reportSessionStatus,
      }),
    );

    expect(code).toBe(5);
    expect(loop).toHaveBeenCalledOnce();
    expect(startPtyClaudeSession).not.toHaveBeenCalled();
    // The remote/ACP flow owns permissions agent-side — no hook server here.
    expect(installRemotePermissionHook).not.toHaveBeenCalled();
    // Same exit-code -> status mapping as the PTY flow (W1.4): a non-zero
    // loop exit reports 'failed', with the code in the error message.
    expect(reportSessionStatus).toHaveBeenCalledOnce();
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams.status).toBe("failed");
    expect(reportParams.error?.message).toBe("claude exited with code 5");
  });

  it("reports the session 'ended' on a clean (code 0) loop exit", async () => {
    const loop = vi.fn(async () => 0);
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--starting-mode", "remote"],
        loop,
        reportSessionStatus,
      }),
    );

    expect(code).toBe(0);
    expect(reportSessionStatus).toHaveBeenCalledOnce();
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams).toEqual({ sessionId: "sess_1", status: "ended", error: undefined });
  });

  it("routes a message RPC into loop()'s onMessage subscribers on the remote flow", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-start-remote-test-"));
    try {
      const received: { id: string; text: string }[] = [];
      const loop = vi.fn(async (options: LoopOptions) => {
        options.onMessage((message) => received.push(message));
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
          claudeArgs: ["--starting-mode", "remote"],
          loop,
          registerSessionRpcHandlers,
        }),
      );

      const handlers = capturedHandlers as unknown as SessionRpcHandlers;
      const envelope = createEnvelope("user", { t: "text", md: "remote hello" });
      const result = await handlers.message({ envelope });
      // Starting mode is remote, so a send is delivered directly (not queued).
      expect(result).toEqual({ queued: false, status: "queued" });
      expect(received).toEqual([{ id: envelope.id, text: "remote hello" }]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

describe("runStartClaudeCommand — SIGTERM/SIGHUP lifecycle-status reporting (W1.4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Belt-and-suspenders: a test that throws before its own cleanup runs
    // must not leave a real signal handler registered for later tests/the
    // test-runner process itself.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
  });

  /**
   * A signal must never short-circuit past this flow's own teardown by
   * calling `process.exit()` directly — it has to request a graceful stop
   * of the PTY child and let `ptySession.done` (and both flows' `finally`
   * blocks) settle for real. `stop()` here simulates the real
   * `ptyClaudeSession.ts` contract exactly, including its own idempotency
   * guard ("safe to call once"): it sends SIGTERM to the pty child, and
   * `done` only resolves once that child actually exits.
   */
  function fakeStoppablePtyHandle(): {
    handle: PtyClaudeSessionHandle;
    stop: ReturnType<typeof vi.fn>;
  } {
    let resolveDone: (code: number) => void = () => {};
    const done = new Promise<number>((resolve) => {
      resolveDone = resolve;
    });
    let stopped = false;
    const stop = vi.fn(() => {
      if (stopped) return;
      stopped = true;
      resolveDone(0);
    });
    return { handle: fakePtyHandle({ done, stop }), stop };
  }

  it("gracefully stops the PTY child and tears down every resource on SIGTERM, exiting 0 without calling process.exit", async () => {
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
    const { handle, stop } = fakeStoppablePtyHandle();
    const startPtyClaudeSession = vi.fn(() => handle);
    const rpcStop = vi.fn();
    const permHookStop = vi.fn(async () => {});
    const sessionClientStop = vi.fn();
    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const resultPromise = runStartClaudeCommand(
      baseDeps({
        startPtyClaudeSession,
        reportSessionStatus,
        registerSessionRpcHandlers: vi.fn(() => ({ stop: rpcStop })),
        installRemotePermissionHook: (async () =>
          fakeRemotePermissionHook({
            stop: permHookStop,
          })) as unknown as typeof installRemotePermissionHookType,
        startSessionClient: vi.fn(() => fakeSessionClientHandle({ stop: sessionClientStop })),
      }),
    );

    await vi.waitFor(() => {
      expect(onSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true);
    });
    const sigtermCall = onSpy.mock.calls.find(([event]) => event === "SIGTERM");
    const handler = sigtermCall?.[1] as ((signal: NodeJS.Signals) => void) | undefined;
    expect(handler).toBeDefined();

    // Fire it twice — a signal racing itself (or a duplicate delivery) must
    // still only report once (the `statusReported` guard). `stop()` itself
    // is invoked more than once here (once per signal delivery, plus once
    // more from `runLocalPty`'s own `finally`) but that's fine — the real
    // `ptyClaudeSession.ts` implementation guards it to actually kill the
    // child exactly once; what matters is that it's requested at all.
    handler?.("SIGTERM");
    handler?.("SIGTERM");

    const code = await resultPromise;

    // The actual fix under test: every resource the PTY flow and the outer
    // wrapper own was torn down — nothing orphaned, nothing skipped.
    expect(stop).toHaveBeenCalled();
    expect(rpcStop).toHaveBeenCalledTimes(1);
    expect(permHookStop).toHaveBeenCalledTimes(1);
    expect(sessionClientStop).toHaveBeenCalledTimes(1);
    // Never a direct process.exit() short-circuit — the wrapper's own
    // return value is what carries the exit code back to `index.ts`.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(code).toBe(0);

    expect(reportSessionStatus).toHaveBeenCalledTimes(1);
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams).toEqual({ sessionId: "sess_1", status: "ended", error: undefined });
  });

  it("gracefully stops the PTY child and resolves exit code 1 on SIGHUP", async () => {
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
    const { handle, stop } = fakeStoppablePtyHandle();
    const startPtyClaudeSession = vi.fn(() => handle);
    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const resultPromise = runStartClaudeCommand(
      baseDeps({ startPtyClaudeSession, reportSessionStatus }),
    );

    await vi.waitFor(() => {
      expect(onSpy.mock.calls.some(([event]) => event === "SIGHUP")).toBe(true);
    });
    const sighupCall = onSpy.mock.calls.find(([event]) => event === "SIGHUP");
    const handler = sighupCall?.[1] as ((signal: NodeJS.Signals) => void) | undefined;
    expect(handler).toBeDefined();

    handler?.("SIGHUP");

    const code = await resultPromise;

    // Invoked at least once from the signal handler itself; `runLocalPty`'s
    // own `finally` calls it again, harmlessly (same idempotency note as
    // the SIGTERM test above).
    expect(stop).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(code).toBe(1);

    expect(reportSessionStatus).toHaveBeenCalledTimes(1);
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams).toEqual({ sessionId: "sess_1", status: "ended", error: undefined });
  });

  it("removes the SIGTERM/SIGHUP listeners once the session ends normally, so they never leak across runs", async () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeHup = process.listenerCount("SIGHUP");

    const code = await runStartClaudeCommand(baseDeps());

    expect(code).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGHUP")).toBe(beforeHup);
  });
});
