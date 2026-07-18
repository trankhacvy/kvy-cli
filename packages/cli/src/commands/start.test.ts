import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
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
    setPromptOpen: vi.fn(),
    sendInterrupt: vi.fn(() => true),
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
    markLocalActivity: () => {},
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

  it("clears the web-turn flag when the PTY reports a locally-typed submit", async () => {
    let onLocalSubmit: (() => void) | undefined;
    const startPtyClaudeSession = vi.fn((opts: PtyClaudeSessionOptions) => {
      onLocalSubmit = opts.onLocalSubmit;
      return fakePtyHandle();
    });
    const markLocalActivity = vi.fn();
    const installRemotePermissionHook = (async () =>
      fakeRemotePermissionHook({
        markLocalActivity,
      })) as unknown as typeof installRemotePermissionHookType;

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, installRemotePermissionHook }));

    expect(markLocalActivity).not.toHaveBeenCalled();
    onLocalSubmit?.();
    expect(markLocalActivity).toHaveBeenCalledOnce();
  });

  it("gates injection on hook attention: perm/question open the prompt gate, done clears it", async () => {
    const setPromptOpen = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ setPromptOpen }));
    let onAttention: ((kind: "perm" | "question" | "done") => void) | undefined;
    const installRemotePermissionHook = (async (opts: {
      onAttention?: (kind: "perm" | "question" | "done") => void;
    }) => {
      onAttention = opts.onAttention;
      return fakeRemotePermissionHook();
    }) as unknown as typeof installRemotePermissionHookType;

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, installRemotePermissionHook }));

    onAttention?.("perm");
    expect(setPromptOpen).toHaveBeenLastCalledWith(true);
    onAttention?.("question");
    expect(setPromptOpen).toHaveBeenLastCalledWith(true);
    onAttention?.("done");
    expect(setPromptOpen).toHaveBeenLastCalledWith(false);
  });

  it("does not open the prompt gate on perm/question while a web turn is active (no local dialog rendered), but done still clears it", async () => {
    const setPromptOpen = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ setPromptOpen }));
    let onAttention: ((kind: "perm" | "question" | "done") => void) | undefined;
    const installRemotePermissionHook = (async (opts: {
      onAttention?: (kind: "perm" | "question" | "done") => void;
    }) => {
      onAttention = opts.onAttention;
      return fakeRemotePermissionHook({ isWebTurnActive: () => true });
    }) as unknown as typeof installRemotePermissionHookType;

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, installRemotePermissionHook }));

    onAttention?.("perm");
    onAttention?.("question");
    expect(setPromptOpen).not.toHaveBeenCalled();
    onAttention?.("done");
    expect(setPromptOpen).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("opens the prompt gate when the bridge signals a local-turn dialog is likely", async () => {
    const setPromptOpen = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ setPromptOpen }));
    let onPromptLikely: (() => void) | undefined;
    const installRemotePermissionHook = (async (opts: { onPromptLikely?: () => void }) => {
      onPromptLikely = opts.onPromptLikely;
      return fakeRemotePermissionHook();
    }) as unknown as typeof installRemotePermissionHookType;

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, installRemotePermissionHook }));

    expect(setPromptOpen).not.toHaveBeenCalled();
    onPromptLikely?.();
    expect(setPromptOpen).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("clears the prompt gate when a tool-end envelope lands, and still forwards every envelope to the outbox", async () => {
    const setPromptOpen = vi.fn();
    let onEnvelopes: ((envelopes: SessionEnvelope[]) => void) | undefined;
    const startPtyClaudeSession = vi.fn((opts: PtyClaudeSessionOptions) => {
      onEnvelopes = opts.onEnvelopes;
      return fakePtyHandle({ setPromptOpen });
    });

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession }));

    const textEnvelope = createEnvelope("agent", { t: "text", md: "hi" });
    onEnvelopes?.([textEnvelope]);
    expect(setPromptOpen).not.toHaveBeenCalled();

    const toolEndEnvelope = createEnvelope("agent", {
      t: "tool-end",
      call: "call-1",
      ok: true,
      output: {},
    });
    onEnvelopes?.([toolEndEnvelope]);
    expect(setPromptOpen).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("answers takeControl as a no-op success, interrupt as a real ESC write, setMode as not-supported, and routes perm.answer into the hook bridge", async () => {
    const resolvePermission = vi.fn(() => ({ ok: true as const }));
    const installRemotePermissionHook = (async () =>
      fakeRemotePermissionHook({
        resolvePermission,
      })) as unknown as typeof installRemotePermissionHookType;
    const sendInterrupt = vi.fn(() => true);
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ sendInterrupt }));

    let capturedHandlers: SessionRpcHandlers | null = null;
    const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
      capturedHandlers = rpcDeps.handlers;
      return { stop: vi.fn() };
    });

    await runStartClaudeCommand(
      baseDeps({
        registerSessionRpcHandlers,
        installRemotePermissionHook,
        startPtyClaudeSession,
      }),
    );

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    await expect(handlers.takeControl()).resolves.toEqual({ ok: true });
    await expect(handlers.interrupt()).resolves.toEqual({ ok: true });
    expect(sendInterrupt).toHaveBeenCalledOnce();
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

  it("interrupt reflects sendInterrupt()'s real return value, not a hardcoded true", async () => {
    const sendInterrupt = vi.fn(() => false);
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ sendInterrupt }));
    let capturedHandlers: SessionRpcHandlers | null = null;
    const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
      capturedHandlers = rpcDeps.handlers;
      return { stop: vi.fn() };
    });

    await runStartClaudeCommand(
      baseDeps({
        registerSessionRpcHandlers,
        startPtyClaudeSession,
      }),
    );

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    await expect(handlers.interrupt()).resolves.toEqual({ ok: false });
    expect(sendInterrupt).toHaveBeenCalledOnce();
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
  it("keeps the headless mode loop (never the PTY or a hook server) and starts it in remote mode", async () => {
    const loop = vi.fn(async (options: LoopOptions) => {
      expect(options.startingMode).toBe("remote");
      return 5;
    });
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());
    const installRemotePermissionHook = vi.fn(async () => fakeRemotePermissionHook());

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--starting-mode", "remote", "--started-by", "daemon"],
        loop,
        startPtyClaudeSession,
        installRemotePermissionHook:
          installRemotePermissionHook as unknown as typeof installRemotePermissionHookType,
      }),
    );

    expect(code).toBe(5);
    expect(loop).toHaveBeenCalledOnce();
    expect(startPtyClaudeSession).not.toHaveBeenCalled();
    // The remote/ACP flow owns permissions agent-side — no hook server here.
    expect(installRemotePermissionHook).not.toHaveBeenCalled();
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
