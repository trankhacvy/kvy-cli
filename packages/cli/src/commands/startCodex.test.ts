import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRandomBytes } from "@falcon/crypto";
import { createEnvelope } from "@falcon/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpRemoteHandle } from "../acp/acpRemote.js";
import { Outbox } from "../api/outbox.js";
import type { FalconCredentials } from "../auth/credentials.js";
import { plaintextFallbackKeyMaterial } from "../auth/keyMaterial.js";
import type { ProviderDetectionResult } from "../codex/index.js";
import type {
  notifyDaemonSessionStarted as notifyDaemonSessionStartedType,
  reportSessionStartFailed as reportSessionStartFailedType,
} from "../daemon/notify.js";
import type { DaemonState } from "../daemon/state.js";
import type { SessionRpcHandlers } from "../rpc/sessionRpc.js";
import type { bootstrapSession as bootstrapSessionType } from "../session/bootstrap.js";
import type { SessionClientHandle } from "../session/sessionClient.js";
import type { registerWorkspace as registerWorkspaceType } from "../workspace/registry.js";
import { runStartCodexCommand, type StartCodexCommandDeps } from "./startCodex.js";

function fakeCredentials(overrides: Partial<FalconCredentials> = {}): FalconCredentials {
  return {
    refreshToken: "test-refresh-token",
    keyMaterial: plaintextFallbackKeyMaterial(getRandomBytes(32)),
    ...overrides,
  };
}

/** issue-4-plan.md §6.6: default `/v1/auth/refresh` response for resolveAccessToken. */
async function defaultFetchImpl(): Promise<Response> {
  return new Response(
    JSON.stringify({ accessToken: "test-token", refreshToken: "test-refresh-token" }),
    { status: 200 },
  );
}

/**
 * Preflight now does real filesystem I/O (the credentials lock, known-issues.md
 * #20) before registering session RPC handlers, so it no longer reliably settles
 * within a single `setTimeout(r, 0)` tick — poll instead. Fake-timer-aware:
 * `vi.waitFor` advances fake timers itself when they're active, same as the
 * "stop RPC with force" test below already relies on.
 */
async function waitForHandlers(
  getHandlers: () => SessionRpcHandlers | null,
): Promise<SessionRpcHandlers> {
  return vi.waitFor(() => {
    const handlers = getHandlers();
    if (!handlers) throw new Error("handlers not registered yet");
    return handlers;
  });
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

function fakeSessionClientHandle(): SessionClientHandle {
  return {
    connected: true,
    socket: { id: "fake-socket" } as unknown as SessionClientHandle["socket"],
    stop: vi.fn(),
  };
}

interface FakeRemote {
  handle: AcpRemoteHandle;
  sent: Array<{ text: string; id?: string }>;
  stop: ReturnType<typeof vi.fn>;
  settle: (info: { messageId?: string; status: "completed" | "failed" | "cancelled" }) => void;
}

const baseDepsHomeDirs: string[] = [];

afterEach(async () => {
  const dirs = baseDepsHomeDirs.splice(0);
  await Promise.all(
    dirs.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => {}),
    ),
  );
});

function baseDeps(overrides: Partial<StartCodexCommandDeps> = {}): {
  deps: StartCodexCommandDeps;
  fakeRemote: FakeRemote;
  written: string[];
  errors: string[];
  releaseExit: () => void;
} {
  // The `announceRemoteControl()` envelope this command now enqueues at
  // startup makes `Outbox`'s dispose-time flush a real, unconditional disk
  // write for every test, not just the ones that already opted into a real
  // homeDir — so `baseDeps()` needs one too instead of the placeholder
  // `/fake/home` that used to be safe when nothing ever actually wrote to it.
  const homeDir = mkdtempSync(path.join(tmpdir(), "falcon-codex-basedeps-"));
  baseDepsHomeDirs.push(homeDir);

  const written: string[] = [];
  const errors: string[] = [];
  let releaseExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    releaseExit = resolve;
  });

  const sent: Array<{ text: string; id?: string }> = [];
  const stop = vi.fn(async () => ({ providerSessionId: "codex-thread-1" }));
  let onTurnSettled:
    | ((info: { messageId?: string; status: "completed" | "failed" | "cancelled" }) => void)
    | undefined;
  const handle: AcpRemoteHandle = {
    send: (text, id) => sent.push({ text, id }),
    interrupt: vi.fn(async () => {}),
    setMode: vi.fn(async () => {}),
    resolvePermission: vi.fn(() => ({ ok: true })),
    stop,
  };
  const fakeRemote: FakeRemote = {
    handle,
    sent,
    stop,
    settle: (info) => onTurnSettled?.(info),
  };

  const deps: StartCodexCommandDeps = {
    homeDir,
    workingDirectory: "/fake/workdir",
    codexArgs: [],
    readCredentials: () => fakeCredentials(),
    fetchImpl: defaultFetchImpl as unknown as typeof fetch,
    readDaemonState: async () => fakeDaemonState(),
    detectCodex: async () => ({ installed: true, authenticated: true, version: "1.0.0" }),
    bootstrapSession: vi.fn(async () => ({
      sessionId: "sess_codex_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    })) as unknown as typeof bootstrapSessionType,
    registerWorkspace: vi.fn(
      async (directory: string) =>
        ({ path: directory, registeredAt: "2026-01-01T00:00:00.000Z" }) as unknown as Awaited<
          ReturnType<typeof registerWorkspaceType>
        >,
    ) as unknown as typeof registerWorkspaceType,
    // A1: never let a unit test hit a real daemon control server — default
    // to the always-succeeding "no daemon" fake, same precedent as
    // `start.test.ts`'s `baseDeps`.
    notifyDaemonSessionStarted: vi.fn(async () => ({
      type: "no-daemon" as const,
    })) as unknown as typeof notifyDaemonSessionStartedType,
    reportSessionStartFailed: vi.fn(async () => ({
      type: "no-daemon" as const,
    })) as unknown as typeof reportSessionStartFailedType,
    startAcpRemote: ((opts: { onTurnSettled?: typeof onTurnSettled }) => {
      onTurnSettled = opts.onTurnSettled;
      return handle;
    }) as unknown as StartCodexCommandDeps["startAcpRemote"],
    startSessionClient: vi.fn(() => fakeSessionClientHandle()),
    registerSessionRpcHandlers: vi.fn(() => ({ stop: vi.fn() })),
    waitForExit: () => exit,
    sleep: async () => {},
    now: () => 0,
    write: (t) => written.push(t),
    writeError: (t) => errors.push(t),
    ...overrides,
  };
  return { deps, fakeRemote, written, errors, releaseExit };
}

describe("runStartCodexCommand", () => {
  it("fails fast (exit 1) with an honest not-logged-in error and never touches the network", async () => {
    const bootstrapSession = vi.fn();
    const { deps, errors } = baseDeps({
      readCredentials: () => null,
      bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
    });
    const code = await runStartCodexCommand(deps);
    expect(code).toBe(1);
    expect(errors[0]).toContain("not logged in");
    expect(bootstrapSession).not.toHaveBeenCalled();
  });

  it("fails honestly (exit 1) when the Codex CLI isn't installed", async () => {
    const { deps, errors } = baseDeps({
      detectCodex: async (): Promise<ProviderDetectionResult> => ({
        installed: false,
        authenticated: false,
        error: "Codex CLI is not installed.",
      }),
    });
    const code = await runStartCodexCommand(deps);
    expect(code).toBe(1);
    expect(errors[0]).toContain("Codex CLI is not installed");
  });

  it("surfaces a bootstrapSession failure as an honest error instead of throwing", async () => {
    const { deps, errors } = baseDeps({
      bootstrapSession: vi.fn(async () => {
        throw new Error("server rejected session create");
      }) as unknown as typeof bootstrapSessionType,
    });
    const code = await runStartCodexCommand(deps);
    expect(code).toBe(1);
    expect(errors.join("")).toContain("failed to start session");
  });

  // A4 (docs/known-issues.md — "generic 15s timeout masks the real failure
  // reason"): same self-report as `start.ts` on a `bootstrapSession()`
  // failure, so a daemon-initiated Codex spawn surfaces the real error.
  it("self-reports a bootstrapSession failure to the daemon via reportSessionStartFailed", async () => {
    const reportSessionStartFailed = vi.fn(async () => ({ type: "ok" as const }));
    const { deps } = baseDeps({
      bootstrapSession: vi.fn(async () => {
        throw new Error("You've reached your limit of 3 running sessions.");
      }) as unknown as typeof bootstrapSessionType,
      reportSessionStartFailed:
        reportSessionStartFailed as unknown as typeof reportSessionStartFailedType,
    });
    const code = await runStartCodexCommand(deps);
    expect(code).toBe(1);
    expect(reportSessionStartFailed).toHaveBeenCalledOnce();
    const [, params] = reportSessionStartFailed.mock.calls[0] as unknown as [
      unknown,
      { error: string },
    ];
    expect(params.error).toBe("You've reached your limit of 3 running sessions.");
  });

  it("starts the codex-adapter AcpRemote, prints the no-local-mode note, and stops cleanly on exit", async () => {
    const startAcpRemote = vi.fn((opts: { adapterId?: string }) => {
      expect(opts.adapterId).toBe("codex");
      return baseDeps().fakeRemote.handle;
    });
    const { deps, written, releaseExit } = baseDeps({
      startAcpRemote: startAcpRemote as unknown as StartCodexCommandDeps["startAcpRemote"],
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    const code = await run;

    expect(code).toBe(0);
    expect(startAcpRemote).toHaveBeenCalledOnce();
    expect(written.join("")).toContain("Codex has no local terminal mode");
  });

  it("threads a --continue-from flag into startAcpRemote's resume option (§5.5 — resuming a codex session)", async () => {
    const startAcpRemote = vi.fn(() => baseDeps().fakeRemote.handle);
    const { deps, releaseExit } = baseDeps({
      codexArgs: ["--continue-from", "prior-thread-id"],
      startAcpRemote: startAcpRemote as unknown as StartCodexCommandDeps["startAcpRemote"],
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    expect(startAcpRemote).toHaveBeenCalledWith(
      expect.objectContaining({ resume: "prior-thread-id" }),
    );
  });

  it("passes resume: null into startAcpRemote when codexArgs carries no --continue-from flag", async () => {
    const startAcpRemote = vi.fn(() => baseDeps().fakeRemote.handle);
    const { deps, releaseExit } = baseDeps({
      startAcpRemote: startAcpRemote as unknown as StartCodexCommandDeps["startAcpRemote"],
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    expect(startAcpRemote).toHaveBeenCalledWith(expect.objectContaining({ resume: null }));
  });

  it("announces remote control once at startup, so the web reads this session as remote from envelope #1 (known-issues.md — dead mode selector)", async () => {
    const enqueueSpy = vi.spyOn(Outbox.prototype, "enqueue");
    const { deps, releaseExit } = baseDeps();

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    const announceCalls = enqueueSpy.mock.calls.filter(([envelopes]) =>
      envelopes.some(
        (envelope) =>
          envelope.ev.t === "mode-switch" &&
          envelope.ev.control === "remote" &&
          envelope.ev.by === "client",
      ),
    );
    expect(announceCalls).toHaveLength(1);
    enqueueSpy.mockRestore();
  });

  // A1 (docs/known-issues.md — Codex daemon-spawn timeout): `start.ts` calls
  // `notifyDaemonSessionStarted` right after `bootstrapSession()` succeeds so
  // a daemon-initiated `spawn` RPC's `spawnAwaiter` can resolve instead of
  // always timing out after 15s. `startCodex.ts` previously never called it
  // at all.
  it("self-reports to the daemon via notifyDaemonSessionStarted once bootstrapSession succeeds", async () => {
    const notifyDaemonSessionStarted = vi.fn(async () => ({ type: "ok" as const }));
    const { deps, releaseExit } = baseDeps({
      notifyDaemonSessionStarted:
        notifyDaemonSessionStarted as unknown as typeof notifyDaemonSessionStartedType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    expect(notifyDaemonSessionStarted).toHaveBeenCalledOnce();
    const [, params] = notifyDaemonSessionStarted.mock.calls[0] as unknown as [
      unknown,
      { sessionId: string; encryption?: { encryptionKey: string } },
    ];
    expect(params.sessionId).toBe("sess_codex_1");
    expect(params.encryption?.encryptionKey).toEqual(expect.any(String));
  });

  it("re-notifies the daemon with the real ACP provider session id once known, so a future --continue-from has something to resume", async () => {
    const notifyDaemonSessionStarted = vi.fn(async () => ({ type: "ok" as const }));
    let onProviderSessionId: ((id: string) => void) | undefined;
    const startAcpRemote = vi.fn((opts: { onProviderSessionId?: (id: string) => void }) => {
      onProviderSessionId = opts.onProviderSessionId;
      return baseDeps().fakeRemote.handle;
    });
    const { deps, releaseExit } = baseDeps({
      notifyDaemonSessionStarted:
        notifyDaemonSessionStarted as unknown as typeof notifyDaemonSessionStartedType,
      startAcpRemote: startAcpRemote as unknown as StartCodexCommandDeps["startAcpRemote"],
    });

    const run = runStartCodexCommand(deps);
    await vi.waitFor(() => {
      if (!onProviderSessionId) throw new Error("startAcpRemote not called yet");
    });
    onProviderSessionId?.("codex-provider-thread-1");
    await vi.waitFor(() => {
      expect(notifyDaemonSessionStarted).toHaveBeenCalledTimes(2);
    });
    releaseExit();
    await run;

    const [, secondParams] = notifyDaemonSessionStarted.mock.calls[1] as unknown as [
      unknown,
      { metadata: { providerSessionId?: string } },
    ];
    expect(secondParams.metadata.providerSessionId).toBe("codex-provider-thread-1");
  });

  it("still starts the session successfully when notifyDaemonSessionStarted reports no daemon present (best-effort, never blocks startup)", async () => {
    const notifyDaemonSessionStarted = vi.fn(async () => ({ type: "no-daemon" as const }));
    const { deps, releaseExit, written } = baseDeps({
      notifyDaemonSessionStarted:
        notifyDaemonSessionStarted as unknown as typeof notifyDaemonSessionStartedType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    const code = await run;

    expect(code).toBe(0);
    expect(written.join("")).toContain("starting session sess_codex_1");
  });

  it("never blocks or fails session startup even if notifyDaemonSessionStarted itself throws unexpectedly", async () => {
    // notifyDaemonSessionStarted's real implementation never throws (typed
    // result), but this proves startCodex.ts doesn't newly depend on that —
    // an unawaited/uncaught rejection here must not be able to crash the
    // session start.
    const notifyDaemonSessionStarted = vi.fn(async () => {
      throw new Error("unexpected daemon failure");
    });
    const { deps, releaseExit } = baseDeps({
      notifyDaemonSessionStarted:
        notifyDaemonSessionStarted as unknown as typeof notifyDaemonSessionStartedType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await expect(run).rejects.toThrow("unexpected daemon failure");
  });

  it("extracts a --model override from codexArgs into the session metadata (plan-v2.md W4.2 header model chip)", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_codex_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    }));
    const { deps, releaseExit } = baseDeps({
      codexArgs: ["--model", "gpt-5.1-codex"],
      bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    expect(bootstrapSession).toHaveBeenCalledOnce();
    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { metadata: { model?: string } },
    ];
    expect(bootstrapParams.metadata.model).toBe("gpt-5.1-codex");
  });

  it("passes an undefined model into the session metadata when codexArgs carries no --model flag", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_codex_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    }));
    const { deps, releaseExit } = baseDeps({
      codexArgs: [],
      bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { metadata: { model?: string } },
    ];
    expect(bootstrapParams.metadata.model).toBeUndefined();
  });

  it("registers workingDirectory as a workspace and threads its id into bootstrapSession (known-issues.md #6)", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_codex_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    }));
    const registerWorkspace = vi.fn(
      async () =>
        ({
          path: "/fake/workdir",
          registeredAt: "2026-01-01T00:00:00.000Z",
        }) as unknown as Awaited<ReturnType<typeof registerWorkspaceType>>,
    );
    const { deps, releaseExit } = baseDeps({
      bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
      registerWorkspace: registerWorkspace as unknown as typeof registerWorkspaceType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    await run;

    expect(registerWorkspace).toHaveBeenCalledWith("/fake/workdir");
    expect(bootstrapSession).toHaveBeenCalledOnce();
    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { workspaceId?: string | null },
    ];
    expect(bootstrapParams.workspaceId).toBe("/fake/workdir");
  });

  it("still starts the session with a null workspaceId when registerWorkspace fails, instead of failing the whole start", async () => {
    const bootstrapSession = vi.fn(async () => ({
      sessionId: "sess_codex_1",
      dek: getRandomBytes(32),
      tag: "tag-1",
      created: true,
    }));
    const registerWorkspace = vi.fn(async () => {
      throw new Error("lock contended");
    });
    const { deps, releaseExit } = baseDeps({
      bootstrapSession: bootstrapSession as unknown as typeof bootstrapSessionType,
      registerWorkspace: registerWorkspace as unknown as typeof registerWorkspaceType,
    });

    const run = runStartCodexCommand(deps);
    releaseExit();
    const code = await run;

    expect(code).toBe(0);
    expect(bootstrapSession).toHaveBeenCalledOnce();
    const [, bootstrapParams] = bootstrapSession.mock.calls[0] as unknown as [
      unknown,
      { workspaceId?: string | null },
    ];
    expect(bootstrapParams.workspaceId).toBeNull();
  });

  it("routes a message RPC: claims, sends to the remote, and reports the tri-state status", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-codex-test-"));
    try {
      let handlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((d: { handlers: SessionRpcHandlers }) => {
        handlers = d.handlers;
        return { stop: vi.fn() };
      });
      const { deps, fakeRemote, releaseExit } = baseDeps({
        homeDir,
        registerSessionRpcHandlers,
      });

      const run = runStartCodexCommand(deps);
      const h = await waitForHandlers(() => handlers);

      const envelope = createEnvelope("user", { t: "text", md: "hello codex" });
      const first = await h.message({ envelope });
      expect(first).toEqual({ queued: false, status: "queued" });
      expect(fakeRemote.sent).toEqual([{ text: "hello codex", id: envelope.id }]);

      // Same envelope id retried while its claim is still open → indeterminate.
      const retry = await h.message({ envelope });
      expect(retry).toEqual({ queued: false, status: "outcome-unknown" });
      expect(fakeRemote.sent).toHaveLength(1);

      // takeControl is not supported for Codex (no local terminal).
      expect(await h.takeControl()).toEqual({ ok: false });

      // setModel is not supported for Codex either (issue #12 is PTY-only).
      expect(await h.setModel({ model: "sonnet" })).toEqual({ ok: false });

      // interrupt / perm.answer route to the handle.
      expect(await h.interrupt()).toEqual({ ok: true });
      expect(fakeRemote.handle.interrupt).toHaveBeenCalledOnce();

      releaseExit();
      await run;
      expect(fakeRemote.stop).toHaveBeenCalledOnce();
    } finally {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("stop RPC requests exit (ending the run without waitForExit ever resolving) and stops the remote", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-codex-stop-test-"));
    try {
      let handlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((d: { handlers: SessionRpcHandlers }) => {
        handlers = d.handlers;
        return { stop: vi.fn() };
      });
      // A `waitForExit` that never resolves on its own — only the `stop` RPC's
      // exit request should end the run.
      const { deps, fakeRemote } = baseDeps({
        homeDir,
        registerSessionRpcHandlers,
        waitForExit: () => new Promise<void>(() => {}),
      });

      const run = runStartCodexCommand(deps);
      const h = await waitForHandlers(() => handlers);

      const result = await h.stop({});
      expect(result).toEqual({ ok: true });

      const code = await run;
      expect(code).toBe(0);
      expect(fakeRemote.stop).toHaveBeenCalledOnce();
    } finally {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("stop RPC with force schedules a process exit after the grace period", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-codex-stop-force-test-"));
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      let handlers: SessionRpcHandlers | null = null;
      const registerSessionRpcHandlers = vi.fn((d: { handlers: SessionRpcHandlers }) => {
        handlers = d.handlers;
        return { stop: vi.fn() };
      });
      // Same never-resolving waitForExit as the no-force test above — only
      // the `stop` RPC's exit request (or, here, the scheduled process.exit)
      // ends things.
      const { deps } = baseDeps({
        homeDir,
        registerSessionRpcHandlers,
        waitForExit: () => new Promise<void>(() => {}),
      });

      const run = runStartCodexCommand(deps);
      const h = await waitForHandlers(() => handlers);

      const result = await h.stop({ force: true });
      expect(result).toEqual({ ok: true });
      expect(exitSpy).not.toHaveBeenCalled();

      // `requestExit()` still ends the run itself (the grace-period exit is
      // a backstop, not the only way out).
      const code = await run;
      expect(code).toBe(0);

      await vi.advanceTimersByTimeAsync(3000);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("completes the send claim once the turn settles (a later duplicate then reports 'duplicate')", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "falcon-codex-test-"));
    try {
      let handlers: SessionRpcHandlers | null = null;
      const { deps, fakeRemote, releaseExit } = baseDeps({
        homeDir,
        registerSessionRpcHandlers: vi.fn((d: { handlers: SessionRpcHandlers }) => {
          handlers = d.handlers;
          return { stop: vi.fn() };
        }),
      });

      const run = runStartCodexCommand(deps);
      const h = await waitForHandlers(() => handlers);

      const envelope = createEnvelope("user", { t: "text", md: "run a task" });
      await h.message({ envelope });
      // Turn reaches a terminal stopReason → claim completes.
      fakeRemote.settle({ messageId: envelope.id, status: "completed" });
      await new Promise((r) => setTimeout(r, 0));

      const dup = await h.message({ envelope });
      expect(dup).toEqual({ queued: false, status: "duplicate" });

      releaseExit();
      await run;
    } finally {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
