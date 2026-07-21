import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeBase64, getRandomBytes, open } from "@falcon/crypto";
import { createEnvelope, type EncryptedBox, type SessionEnvelope } from "@falcon/wire";
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
import type { notifyDaemonSessionStarted as notifyDaemonSessionStartedType } from "../daemon/notify.js";
import type { DaemonState } from "../daemon/state.js";
import type { ClaudeCliLocation } from "../provider/claudeCliLocator.js";
import type { SessionRpcHandlers } from "../rpc/sessionRpc.js";
import type { bootstrapSession as bootstrapSessionType } from "../session/bootstrap.js";
import type { SessionClientHandle } from "../session/sessionClient.js";
import type {
  acquireSessionLock as acquireSessionLockType,
  SessionLockHandle,
} from "../session/sessionLock.js";
import { type OutboxLike, runStartClaudeCommand, type StartClaudeCommandDeps } from "./start.js";

/** Captures every envelope batch handed to `outbox.enqueue()` — stands in for
 * the real `Outbox` (which seals/persists/POSTs, all things a unit test must
 * never do) so W3.3's lifecycle `service` envelopes are directly observable. */
function fakeOutbox(): { outbox: OutboxLike; enqueued: SessionEnvelope[][] } {
  const enqueued: SessionEnvelope[][] = [];
  return {
    outbox: {
      enqueue: (events) => {
        enqueued.push([...events]);
      },
      dispose: () => {},
    },
    enqueued,
  };
}

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
    sendModeCycle: vi.fn(() => true),
    closeTurn: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

function readMetadataUpdateBody(body: RequestInit["body"]): {
  expectedVersion: number;
  value: EncryptedBox;
} {
  if (typeof body !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(body) as { expectedVersion: number; value: EncryptedBox };
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
    getCurrentPermissionMode: () => null,
    waitForModeEcho: async () => null,
    isWebTurnActive: () => false,
    markWebTurnStart: () => {},
    markTurnEnd: () => {},
    markLocalActivity: () => {},
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

/** A fake, always-succeeding session-lock handle — never touches real disk. */
function fakeSessionLockHandle(overrides: Partial<SessionLockHandle> = {}): SessionLockHandle {
  return {
    release: vi.fn(async () => {}),
    updateSessionId: vi.fn(async () => {}),
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
    // Never touch a real disk queue under the fake homeDir — W3.3's lifecycle
    // `service` envelopes now enqueue unconditionally, so every test needs a
    // safe default outbox even when it isn't asserting on the enqueued
    // content itself (see the `fakeOutbox()` helper above).
    createOutbox: () => fakeOutbox().outbox,
    // Never let a unit test hit the real backend for a lifecycle-status
    // report (W1.4) — same "no real network from a unit test" rule every
    // other injected dep here already follows.
    reportSessionStatus: vi.fn(async () => ({ type: "ok" }) as const),
    // Never let a unit test hit the real backend for an attention-notify
    // report (docs/user-flows.md fix-plan task 4) either.
    reportSessionAttention: vi.fn(async () => ({ type: "ok" }) as const),
    // Never touch a real per-directory lock file or a real daemon control
    // server from a unit test — both default to safe, always-succeeding fakes.
    acquireSessionLock: vi.fn(async () => ({
      ok: true,
      handle: fakeSessionLockHandle(),
    })) as unknown as typeof acquireSessionLockType,
    notifyDaemonSessionStarted: vi.fn(async () => ({
      type: "no-daemon",
    })) as unknown as typeof notifyDaemonSessionStartedType,
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
          fakeCredentials({
            masterSecretOrContentBundle: encodeBase64(getRandomBytes(16)),
          }),
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

  it("extracts a --model override from claudeArgs into the session metadata (plan-v2.md W4.2 header model chip)", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    }));

    await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--model", "opus", "--verbose"],
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
      }),
    );

    expect(bootstrapSession).toHaveBeenCalledOnce();
    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { metadata: { model?: string } },
    ];
    expect(bootstrapParams.metadata.model).toBe("opus");
  });

  it("passes an undefined model into the session metadata when claudeArgs carries no --model flag", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    }));

    await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--verbose"],
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
      }),
    );

    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { metadata: { model?: string } },
    ];
    expect(bootstrapParams.metadata.model).toBeUndefined();
  });

  it("resumes the provider transcript from FALCON_RECONNECT_PROVIDER_SESSION_ID when set (plan-v2.md W3.7)", async () => {
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());

    await runStartClaudeCommand(
      baseDeps({
        env: { FALCON_RECONNECT_PROVIDER_SESSION_ID: "provider-sess-abc" },
        startPtyClaudeSession,
      }),
    );

    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    expect(ptyOptions.providerSessionId).toBe("provider-sess-abc");
  });

  it("treats a whitespace-only FALCON_RECONNECT_PROVIDER_SESSION_ID as absent, not a truthy sessionId", async () => {
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());

    await runStartClaudeCommand(
      baseDeps({
        env: { FALCON_RECONNECT_PROVIDER_SESSION_ID: "   " },
        startPtyClaudeSession,
      }),
    );

    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    expect(ptyOptions.providerSessionId).toBeNull();
  });

  it("passes env through to bootstrapSession so it can honor FALCON_RECONNECT_SESSION_ID", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_1",
      dek: getRandomBytes(32),
      tag: "",
      created: false,
    }));
    const reconnectEnv = {
      FALCON_RECONNECT_SESSION_ID: "sess_existing",
      FALCON_RECONNECT_ENCRYPTION_KEY: "wrapped-dek",
    };

    await runStartClaudeCommand(
      baseDeps({
        env: reconnectEnv,
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
      }),
    );

    expect(bootstrapSession).toHaveBeenCalledOnce();
    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { env?: NodeJS.ProcessEnv },
    ];
    expect(bootstrapParams.env).toMatchObject(reconnectEnv);
  });

  it("persists a live /model change from PTY transcript envelopes into session metadata", async () => {
    const dek = getRandomBytes(32);
    const fetchCalls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchCalls.push(init ?? {});
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    };
    const startPtyClaudeSession = vi.fn((options: PtyClaudeSessionOptions) => {
      options.onEnvelopes([
        createEnvelope("agent", {
          t: "text",
          md: "Set model to Opus and saved as your default for new sessions.",
          thinking: false,
        }),
      ]);
      return fakePtyHandle();
    });

    await runStartClaudeCommand(
      baseDeps({
        fetchImpl,
        bootstrapSession: vi.fn(async () => ({
          sessionId: "sess_1",
          dek,
          tag: "tag-1",
          created: true,
        })) as unknown as typeof bootstrapSessionType,
        startPtyClaudeSession,
      }),
    );

    expect(fetchCalls).toHaveLength(1);
    const body = readMetadataUpdateBody(fetchCalls[0]?.body);
    expect(body.expectedVersion).toBe(0);
    expect(open(body.value, dek)).toMatchObject({ model: "Opus" });
  });

  it("wires the full daemon-resume env contract end-to-end: bootstrapSession re-attaches AND the PTY resumes the provider transcript from the same call", async () => {
    // The combination `daemon/resumeSession.ts`'s `buildReconnectEnv()` actually
    // produces (session re-attach) plus a provider session id a caller layered
    // on top for the terminal case — both must flow through this single
    // `runStartClaudeCommand` call without one clobbering the other.
    const fullReconnectEnv = {
      FALCON_RECONNECT_SESSION_ID: "sess_existing",
      FALCON_RECONNECT_ENCRYPTION_KEY: "wrapped-dek",
      FALCON_RECONNECT_PROVIDER_SESSION_ID: "provider-sess-xyz",
    };
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_existing",
      dek: getRandomBytes(32),
      tag: "",
      created: false,
    }));
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());

    await runStartClaudeCommand(
      baseDeps({
        env: fullReconnectEnv,
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        startPtyClaudeSession,
      }),
    );

    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { env?: NodeJS.ProcessEnv },
    ];
    expect(bootstrapParams.env).toMatchObject(fullReconnectEnv);

    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    expect(ptyOptions.providerSessionId).toBe("provider-sess-xyz");
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
    expect(ptyOptions.settingsEnv).toEqual({
      FALCON_HOOK_SETTINGS_PATH: "/tmp/hooks/s.json",
    });
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
        baseDeps({
          homeDir,
          startPtyClaudeSession,
          registerSessionRpcHandlers,
        }),
      );

      const handlers = capturedHandlers as unknown as SessionRpcHandlers;

      // A fresh send is claimed and typed into the PTY.
      const envelope = createEnvelope("user", {
        t: "text",
        md: "hello from web",
      });
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

  it("completes a dropped injection's claim as dropped-session-ended so a retry sees an honest duplicate (W3.9)", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-start-test-"));
    try {
      let onDroppedInjections: ((messages: { id: string; text: string }[]) => void) | undefined;
      const startPtyClaudeSession = vi.fn((opts: PtyClaudeSessionOptions) => {
        onDroppedInjections = opts.onDroppedInjections;
        return fakePtyHandle();
      });

      let capturedHandlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
        capturedHandlers = rpcDeps.handlers;
        return { stop: vi.fn() };
      });

      await runStartClaudeCommand(
        baseDeps({
          homeDir,
          startPtyClaudeSession,
          registerSessionRpcHandlers,
        }),
      );

      const handlers = capturedHandlers as unknown as SessionRpcHandlers;

      // A fresh send is claimed (never injected — the session ends with it
      // still queued, e.g. `claude` exited before the PTY gate opened).
      const envelope = createEnvelope("user", {
        t: "text",
        md: "never delivered",
      });
      const result = await handlers.message({ envelope });
      expect(result).toEqual({ queued: true, status: "queued" });

      // The PTY session reports it as dropped (`ptyClaudeSession.ts`'s
      // `onDroppedInjections`, threaded from `InjectionController.dispose()`
      // or its submit-skip path) instead of leaving the claim open forever.
      onDroppedInjections?.([{ id: envelope.id, text: "never delivered" }]);

      // A retry of the exact same envelope id now sees a completed claim —
      // an honest `duplicate`, never `outcome-unknown` for a message that
      // never actually ran.
      await vi.waitFor(async () => {
        const retry = await handlers.message({ envelope });
        expect(retry).toEqual({ queued: false, status: "duplicate" });
      });
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

  it("closes the turn on the wire and reports 'done' attention the instant the Stop hook fires (fix-plan task 1/4)", async () => {
    const closeTurn = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ closeTurn }));
    let onAttention: ((kind: "perm" | "question" | "done") => void) | undefined;
    const installRemotePermissionHook = (async (opts: {
      onAttention?: (kind: "perm" | "question" | "done") => void;
    }) => {
      onAttention = opts.onAttention;
      return fakeRemotePermissionHook();
    }) as unknown as typeof installRemotePermissionHookType;
    const reportSessionAttention = vi.fn(async () => ({ type: "ok" }) as const);

    await runStartClaudeCommand(
      baseDeps({
        startPtyClaudeSession,
        installRemotePermissionHook,
        reportSessionAttention,
      }),
    );

    expect(closeTurn).not.toHaveBeenCalled();
    expect(reportSessionAttention).not.toHaveBeenCalled();

    onAttention?.("done");

    expect(closeTurn).toHaveBeenCalledExactlyOnceWith("completed");
    expect(reportSessionAttention).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      sessionId: "sess_1",
      kind: "done",
    });
  });

  it("reports 'perm'/'question' attention regardless of local vs. web turn, via the hook's onPendingAttention", async () => {
    let onPendingAttention: ((kind: "perm" | "question") => void) | undefined;
    const installRemotePermissionHook = (async (opts: {
      onPendingAttention?: (kind: "perm" | "question") => void;
    }) => {
      onPendingAttention = opts.onPendingAttention;
      return fakeRemotePermissionHook();
    }) as unknown as typeof installRemotePermissionHookType;
    const reportSessionAttention = vi.fn(async () => ({ type: "ok" }) as const);

    await runStartClaudeCommand(baseDeps({ installRemotePermissionHook, reportSessionAttention }));

    onPendingAttention?.("perm");
    onPendingAttention?.("question");

    expect(reportSessionAttention).toHaveBeenCalledTimes(2);
    expect(reportSessionAttention).toHaveBeenNthCalledWith(1, expect.anything(), {
      sessionId: "sess_1",
      kind: "perm",
    });
    expect(reportSessionAttention).toHaveBeenNthCalledWith(2, expect.anything(), {
      sessionId: "sess_1",
      kind: "question",
    });
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

  it("answers takeControl as a no-op success, interrupt as a real ESC write, setMode as not-supported (flag off), and routes perm.answer into the hook bridge", async () => {
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
        // `FALCON_PTY_SETMODE` deliberately absent — setMode must stay
        // `{ok:false}` by default regardless of what the host's own
        // process.env happens to have (plan-v2.md W4.3, flag-gated).
        env: {},
        registerSessionRpcHandlers,
        installRemotePermissionHook,
        startPtyClaudeSession,
      }),
    );

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    await expect(handlers.takeControl()).resolves.toEqual({ ok: true });
    await expect(handlers.interrupt()).resolves.toEqual({ ok: true });
    expect(sendInterrupt).toHaveBeenCalledOnce();
    await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
      ok: false,
    });

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

  describe("setMode (W4.3 — real PTY setMode, flag-gated behind FALCON_PTY_SETMODE=1)", () => {
    async function setup(overrides: {
      getCurrentPermissionMode?: () =>
        | "default"
        | "acceptEdits"
        | "plan"
        | "bypassPermissions"
        | null;
      waitForModeEcho?: () => Promise<
        "default" | "acceptEdits" | "plan" | "bypassPermissions" | null
      >;
      sendModeCycle?: ReturnType<typeof vi.fn>;
      env?: Record<string, string>;
    }) {
      const sendModeCycle = overrides.sendModeCycle ?? vi.fn(() => true);
      const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ sendModeCycle }));
      const installRemotePermissionHook = (async () =>
        fakeRemotePermissionHook({
          getCurrentPermissionMode: overrides.getCurrentPermissionMode ?? (() => null),
          waitForModeEcho: overrides.waitForModeEcho ?? (async () => null),
        })) as unknown as typeof installRemotePermissionHookType;

      let capturedHandlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
        capturedHandlers = rpcDeps.handlers;
        return { stop: vi.fn() };
      });

      await runStartClaudeCommand(
        baseDeps({
          env: { FALCON_PTY_SETMODE: "1", ...overrides.env },
          installRemotePermissionHook,
          startPtyClaudeSession,
          registerSessionRpcHandlers,
        }),
      );

      return {
        handlers: capturedHandlers as unknown as SessionRpcHandlers,
        sendModeCycle,
      };
    }

    it("stays {ok:false} when the flag is off, even with a cached mode available", async () => {
      const { handlers } = await setup({
        getCurrentPermissionMode: () => "default",
        env: { FALCON_PTY_SETMODE: "0" },
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: false,
      });
    });

    it("is {ok:false} when no permission_mode has been observed yet", async () => {
      const { handlers, sendModeCycle } = await setup({
        getCurrentPermissionMode: () => null,
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: false,
      });
      expect(sendModeCycle).not.toHaveBeenCalled();
    });

    it("is a same-mode no-op — {ok:true} with the current mode, no keystrokes sent", async () => {
      const { handlers, sendModeCycle } = await setup({
        getCurrentPermissionMode: () => "plan",
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: true,
        observedMode: "plan",
      });
      expect(sendModeCycle).not.toHaveBeenCalled();
    });

    it("sends the correct forward press count and reports success once the hook echo confirms it", async () => {
      const { handlers, sendModeCycle } = await setup({
        getCurrentPermissionMode: () => "default",
        waitForModeEcho: async () => "plan",
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: true,
        observedMode: "plan",
      });
      expect(sendModeCycle).toHaveBeenCalledExactlyOnceWith(2); // default -> acceptEdits -> plan
    });

    it("is {ok:false} (carrying the pre-switch mode) when the injection gate is closed", async () => {
      const sendModeCycle = vi.fn(() => false);
      const { handlers } = await setup({
        getCurrentPermissionMode: () => "default",
        sendModeCycle,
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: false,
        observedMode: "default",
      });
    });

    it("is {ok:false} carrying the observed mode when the hook echo doesn't confirm the switch", async () => {
      const { handlers } = await setup({
        getCurrentPermissionMode: () => "default",
        waitForModeEcho: async () => "acceptEdits", // not the requested "plan"
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: false,
        observedMode: "acceptEdits",
      });
    });

    it("is {ok:false} carrying the prior mode when the hook echo never arrives (verification timeout)", async () => {
      const { handlers } = await setup({
        getCurrentPermissionMode: () => "default",
        waitForModeEcho: async () => null,
      });
      await expect(handlers.setMode({ mode: "plan" })).resolves.toEqual({
        ok: false,
        observedMode: "default",
      });
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

  it("stop RPC (no force) calls ptySession.stop() and reports ok without scheduling a process exit", async () => {
    const ptyStop = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ stop: ptyStop }));
    let capturedHandlers: SessionRpcHandlers | null = null;
    const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
      capturedHandlers = rpcDeps.handlers;
      return { stop: vi.fn() };
    });

    await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, registerSessionRpcHandlers }));

    const handlers = capturedHandlers as unknown as SessionRpcHandlers;
    // The `finally` teardown already called ptySession.stop() once by the
    // time the command resolves (done: Promise.resolve(0), the default) —
    // this asserts the RPC handler's OWN call on top of that.
    const callsBeforeHandlerInvocation = ptyStop.mock.calls.length;
    const result = await handlers.stop({});
    expect(result).toEqual({ ok: true });
    expect(ptyStop.mock.calls.length).toBe(callsBeforeHandlerInvocation + 1);
  });

  it("stop RPC with force schedules a process exit after the grace period", async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      const startPtyClaudeSession = vi.fn(() => fakePtyHandle());
      let capturedHandlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((rpcDeps: { handlers: SessionRpcHandlers }) => {
        capturedHandlers = rpcDeps.handlers;
        return { stop: vi.fn() };
      });

      await runStartClaudeCommand(baseDeps({ startPtyClaudeSession, registerSessionRpcHandlers }));

      const handlers = capturedHandlers as unknown as SessionRpcHandlers;
      const result = await handlers.stop({ force: true });
      expect(result).toEqual({ ok: true });
      expect(exitSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3000);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
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
    expect(reportParams).toEqual({
      sessionId: "sess_1",
      status: "ended",
      error: undefined,
    });
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

  // plan-v2.md W3.3 — lifecycle `service` envelopes the web timeline should
  // see even though nothing in the Claude Code transcript says them.
  describe("lifecycle service envelopes", () => {
    it("enqueues a 'session started' service envelope once the PTY session is spawned, then 'session ended' on a clean exit", async () => {
      const { outbox, enqueued } = fakeOutbox();
      const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ done: Promise.resolve(0) }));

      const code = await runStartClaudeCommand(
        baseDeps({ startPtyClaudeSession, createOutbox: () => outbox }),
      );

      expect(code).toBe(0);
      const serviceEnvelopes = enqueued.flat().filter((e) => e.ev.t === "service");
      const serviceTexts = serviceEnvelopes.map((e) =>
        e.ev.t === "service" ? e.ev.text : undefined,
      );
      expect(serviceTexts).toEqual(["session started", "session ended"]);
      expect(serviceEnvelopes.every((e) => e.role === "agent")).toBe(true);
    });

    it("enqueues a distinguishing 'session ended unexpectedly' note for a non-zero exit (covers spawn failures too — ptyClaudeSession.ts's own setup-failure path resolves `done` the same way)", async () => {
      const { outbox, enqueued } = fakeOutbox();
      const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ done: Promise.resolve(1) }));

      const code = await runStartClaudeCommand(
        baseDeps({ startPtyClaudeSession, createOutbox: () => outbox }),
      );

      expect(code).toBe(1);
      const serviceTexts = enqueued
        .flat()
        .filter((e) => e.ev.t === "service")
        .map((e) => (e.ev.t === "service" ? e.ev.text : undefined));
      expect(serviceTexts).toEqual(["session started", "session ended unexpectedly (exit code 1)"]);
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
    expect(reportParams).toEqual({
      sessionId: "sess_1",
      status: "ended",
      error: undefined,
    });
  });

  it("gracefully requests loop() exit on SIGHUP too, fixing the wrapper's exit code to 1", async () => {
    const rpcStop = vi.fn();
    const registerSessionRpcHandlers = vi.fn(() => ({ stop: rpcStop }));
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
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
      expect(onSpy.mock.calls.some(([event]) => event === "SIGHUP")).toBe(true);
    });
    const sighupCall = onSpy.mock.calls.find(([event]) => event === "SIGHUP");
    const handler = sighupCall?.[1] as ((signal: NodeJS.Signals) => void) | undefined;
    expect(handler).toBeDefined();

    handler?.("SIGHUP");

    const code = await resultPromise;

    // SIGHUP's wrapper exit code (1) wins over the loop's own resolved 0 —
    // same "signal exit code always wins" rule as the PTY flow's own test.
    expect(code).toBe(1);
    expect(rpcStop).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    expect(reportSessionStatus).toHaveBeenCalledTimes(1);
    const [, reportParams] = reportSessionStatus.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; status: string; error?: Error },
    ];
    expect(reportParams).toEqual({
      sessionId: "sess_1",
      status: "ended",
      error: undefined,
    });
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
    expect(reportParams).toEqual({
      sessionId: "sess_1",
      status: "ended",
      error: undefined,
    });
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
      const envelope = createEnvelope("user", {
        t: "text",
        md: "remote hello",
      });
      const result = await handlers.message({ envelope });
      expect(result).toEqual({ queued: false, status: "queued" });
      expect(received).toEqual([{ id: envelope.id, text: "remote hello" }]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("persists a live /model change from remote-loop envelopes into session metadata", async () => {
    const dek = getRandomBytes(32);
    const fetchCalls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchCalls.push(init ?? {});
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    };
    const loop = vi.fn(async (options: LoopOptions) => {
      options.onEnvelopes([
        createEnvelope("agent", {
          t: "text",
          md: "Set model to Haiku 4.5.",
          thinking: false,
        }),
      ]);
      return 0;
    });

    await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--starting-mode", "remote"],
        fetchImpl,
        loop,
        bootstrapSession: vi.fn(async () => ({
          sessionId: "sess_1",
          dek,
          tag: "tag-1",
          created: true,
        })) as unknown as typeof bootstrapSessionType,
      }),
    );

    expect(fetchCalls).toHaveLength(1);
    const body = readMetadataUpdateBody(fetchCalls[0]?.body);
    expect(body.expectedVersion).toBe(0);
    expect(open(body.value, dek)).toMatchObject({ model: "Haiku 4.5" });
  });

  it("routes a stop RPC into loop()'s onExitRequested subscribers on the remote flow", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-start-remote-stop-test-"));
    try {
      let exitRequests = 0;
      const loop = vi.fn(async (options: LoopOptions) => {
        options.onExitRequested(() => {
          exitRequests += 1;
        });
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
      const result = await handlers.stop({});
      expect(result).toEqual({ ok: true });
      expect(exitRequests).toBe(1);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("stop RPC with force schedules a process exit after the grace period on the remote flow", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-start-remote-stop-force-test-"));
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      const loop = vi.fn(async (options: LoopOptions) => {
        options.onExitRequested(() => {});
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
      const result = await handlers.stop({ force: true });
      expect(result).toEqual({ ok: true });
      expect(exitSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3000);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
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
    expect(reportParams).toEqual({
      sessionId: "sess_1",
      status: "ended",
      error: undefined,
    });
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
    expect(reportParams).toEqual({
      sessionId: "sess_1",
      status: "ended",
      error: undefined,
    });
  });

  it("awaits the SIGTERM-triggered status report before resolving, even when it settles after the PTY child has already stopped", async () => {
    // Regression test for a race: the signal handler fires `reportStatusOnce`
    // without awaiting it (it's a plain sync callback), and its first-wins
    // `statusReported` guard turns `runLocalPty`'s own *awaited*
    // `reportStatusOnce(...)` call on its normal-exit path into a
    // synchronous no-op once the signal has already tripped it — so nothing
    // in the awaited chain used to actually wait on the network call this
    // handler kicked off. Since `index.ts` calls `process.exit()` the
    // instant this function's returned promise resolves, a status report
    // slower than the PTY child's own shutdown could be silently dropped.
    // Here the child stops (resolves `done`) synchronously inside `stop()`,
    // well before the report settles, to prove the wrapper's own promise
    // still doesn't resolve until the report does too.
    let resolveReport: (value: { type: "ok" }) => void = () => {};
    const reportSessionStatus = vi.fn(
      () =>
        new Promise<{ type: "ok" }>((resolve) => {
          resolveReport = resolve;
        }),
    );
    const { handle } = fakeStoppablePtyHandle();
    const startPtyClaudeSession = vi.fn(() => handle);
    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const resultPromise = runStartClaudeCommand(
      baseDeps({ startPtyClaudeSession, reportSessionStatus }),
    );

    await vi.waitFor(() => {
      expect(onSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true);
    });
    const handler = onSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1] as
      | ((signal: NodeJS.Signals) => void)
      | undefined;
    expect(handler).toBeDefined();

    // Fires the (still-pending) report AND synchronously resolves the PTY
    // child's `done` via `stop()` — the child "wins" the race against the
    // report on purpose.
    handler?.("SIGTERM");

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    // Flush every microtask that doesn't depend on the still-pending report
    // promise (the PTY child's own exit-path teardown, both flows' cleanup).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();

    resolveReport({ type: "ok" });
    const code = await resultPromise;

    expect(settled).toBe(true);
    expect(code).toBe(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("removes the SIGTERM/SIGHUP listeners once the session ends normally, so they never leak across runs", async () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeHup = process.listenerCount("SIGHUP");

    const code = await runStartClaudeCommand(baseDeps());

    expect(code).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGHUP")).toBe(beforeHup);
  });

  it("never registers a SIGINT handler — Ctrl-C reaches the PTY child directly, not this wrapper", async () => {
    const onSpy = vi.spyOn(process, "on");

    const code = await runStartClaudeCommand(baseDeps());

    expect(code).toBe(0);
    expect(onSpy.mock.calls.some(([event]) => event === "SIGINT")).toBe(false);
  });

  it("only reports status once even if a signal fires after the PTY child already exited normally", async () => {
    const reportSessionStatus = vi.fn(async () => ({ type: "ok" }) as const);
    // A `done` that's already resolved by the time the signal fires — the
    // guard (`statusReported`) must hold regardless of which side "wins" the
    // race, not just the signal-first ordering the other tests exercise.
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle({ done: Promise.resolve(0) }));
    const onSpy = vi.spyOn(process, "on");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const code = await runStartClaudeCommand(
      baseDeps({ startPtyClaudeSession, reportSessionStatus }),
    );
    expect(code).toBe(0);
    expect(reportSessionStatus).toHaveBeenCalledTimes(1);

    // The signal handler was registered and then deregistered in the outer
    // `finally` once the command settled; invoking the captured reference
    // directly simulates a signal landing just after normal completion —
    // it must be a harmless no-op, never a second report.
    const sigtermCall = onSpy.mock.calls.find(([event]) => event === "SIGTERM");
    const handler = sigtermCall?.[1] as ((signal: NodeJS.Signals) => void) | undefined;
    expect(handler).toBeDefined();
    handler?.("SIGTERM");

    expect(reportSessionStatus).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("runStartClaudeCommand — same-directory duplicate session lock + daemon registration (W4.4/W4.5)", () => {
  it("refuses to start when the directory lock is held by a live process, reporting its session id and pid", async () => {
    const stderr: string[] = [];
    const acquireSessionLock = vi.fn(async () => ({
      ok: false as const,
      reason: "held-by-running-process" as const,
      existing: { pid: 4242, sessionId: "sess_existing", startedAt: 1 },
    }));
    const bootstrapSession = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());

    const code = await runStartClaudeCommand(
      baseDeps({
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        startPtyClaudeSession,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("sess_existing");
    expect(stderr.join("")).toContain("4242");
    expect(stderr.join("")).toContain("--force-new-session");
    expect(bootstrapSession).not.toHaveBeenCalled();
    expect(startPtyClaudeSession).not.toHaveBeenCalled();
  });

  it("reports 'unknown session id' when the lock's existing payload hasn't been updated yet", async () => {
    const stderr: string[] = [];
    const acquireSessionLock = vi.fn(async () => ({
      ok: false as const,
      reason: "held-by-running-process" as const,
      existing: { pid: 4242, sessionId: null, startedAt: 1 },
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("unknown session id");
  });

  it("fails honestly when the directory lock is contended", async () => {
    const stderr: string[] = [];
    const acquireSessionLock = vi.fn(async () => ({
      ok: false as const,
      reason: "contended" as const,
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("contended");
  });

  it("--force-new-session bypasses the lock entirely and is stripped before reaching the real claude CLI", async () => {
    const acquireSessionLock = vi.fn();
    const startPtyClaudeSession = vi.fn(() => fakePtyHandle());

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--force-new-session", "--some-claude-flag"],
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        startPtyClaudeSession,
      }),
    );

    expect(code).toBe(0);
    expect(acquireSessionLock).not.toHaveBeenCalled();
    const [ptyOptions] = startPtyClaudeSession.mock.calls[0] as unknown as [
      PtyClaudeSessionOptions,
    ];
    expect(ptyOptions.claudeArgs).toEqual(["--some-claude-flag"]);
  });

  it("updates the lock's sessionId and self-reports to the daemon once bootstrap resolves, then releases the lock", async () => {
    const release = vi.fn(async () => {});
    const updateSessionId = vi.fn(async () => {});
    const acquireSessionLock = vi.fn(async () => ({
      ok: true as const,
      handle: fakeSessionLockHandle({ release, updateSessionId }),
    }));
    const notifyDaemonSessionStarted = vi.fn(async () => ({
      type: "ok" as const,
    }));
    const dek = getRandomBytes(32);
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_reported",
      dek,
      tag: "tag-x",
      created: true,
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        notifyDaemonSessionStarted:
          notifyDaemonSessionStarted as unknown as typeof notifyDaemonSessionStartedType,
        bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
        startPtyClaudeSession: vi.fn(() => fakePtyHandle()),
      }),
    );

    expect(code).toBe(0);
    expect(updateSessionId).toHaveBeenCalledWith("sess_reported");
    expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(1);
    const [, params] = notifyDaemonSessionStarted.mock.calls[0] as unknown as [
      unknown,
      {
        sessionId: string;
        encryption?: { encryptionKey: string; seq: number };
      },
    ];
    expect(params.sessionId).toBe("sess_reported");
    expect(typeof params.encryption?.encryptionKey).toBe("string");
    expect(params.encryption?.seq).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the directory lock even when bootstrapSession fails", async () => {
    const release = vi.fn(async () => {});
    const acquireSessionLock = vi.fn(async () => ({
      ok: true as const,
      handle: fakeSessionLockHandle({ release }),
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        bootstrapSession: vi.fn(async () => {
          throw new Error("boom");
        }) as unknown as typeof bootstrapSessionType,
      }),
    );

    expect(code).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("never blocks session startup when the daemon self-report is unreachable (best-effort)", async () => {
    const notifyDaemonSessionStarted = vi.fn(async () => ({
      type: "unreachable" as const,
      error: "ECONNREFUSED",
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        notifyDaemonSessionStarted:
          notifyDaemonSessionStarted as unknown as typeof notifyDaemonSessionStartedType,
        startPtyClaudeSession: vi.fn(() => fakePtyHandle()),
      }),
    );

    expect(code).toBe(0);
    expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(1);
  });

  it("acquires the directory lock keyed by machineId + workingDirectory with this process's own pid", async () => {
    const acquireSessionLock = vi.fn(async () => ({
      ok: true as const,
      handle: fakeSessionLockHandle(),
    }));

    const code = await runStartClaudeCommand(
      baseDeps({
        workingDirectory: "/fake/workdir",
        readDaemonState: async () => fakeDaemonState({ machineId: "machine-xyz" }),
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
      }),
    );

    expect(code).toBe(0);
    expect(acquireSessionLock).toHaveBeenCalledWith(
      "/fake/home",
      { machineId: "machine-xyz", workspacePath: "/fake/workdir" },
      expect.objectContaining({ pid: process.pid, sessionId: null }),
    );
  });

  it("also gates the daemon-spawned remote flow — a lock held by a live process blocks it before loop() ever runs", async () => {
    const stderr: string[] = [];
    const acquireSessionLock = vi.fn(async () => ({
      ok: false as const,
      reason: "held-by-running-process" as const,
      existing: { pid: 4242, sessionId: "sess_existing", startedAt: 1 },
    }));
    const loop = vi.fn(async () => 0);

    const code = await runStartClaudeCommand(
      baseDeps({
        claudeArgs: ["--starting-mode", "remote"],
        acquireSessionLock: acquireSessionLock as unknown as typeof acquireSessionLockType,
        loop,
        writeError: (text) => stderr.push(text),
      }),
    );

    expect(code).toBe(1);
    expect(loop).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("sess_existing");
  });
});
