import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRandomBytes } from "@falcon/crypto";
import { createEnvelope } from "@falcon/wire";
import { describe, expect, it, vi } from "vitest";
import type { AcpRemoteHandle } from "../acp/acpRemote.js";
import type { FalconCredentials } from "../auth/credentials.js";
import { plaintextFallbackKeyMaterial } from "../auth/keyMaterial.js";
import type { ProviderDetectionResult } from "../codex/index.js";
import type { DaemonState } from "../daemon/state.js";
import type { SessionRpcHandlers } from "../rpc/sessionRpc.js";
import type { bootstrapSession as bootstrapSessionType } from "../session/bootstrap.js";
import type { SessionClientHandle } from "../session/sessionClient.js";
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

function baseDeps(overrides: Partial<StartCodexCommandDeps> = {}): {
  deps: StartCodexCommandDeps;
  fakeRemote: FakeRemote;
  written: string[];
  errors: string[];
  releaseExit: () => void;
} {
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
    homeDir: "/fake/home",
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
      // Let startup settle so handlers are registered.
      await new Promise((r) => setTimeout(r, 0));
      const h = handlers as unknown as SessionRpcHandlers;

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
      await rm(homeDir, { recursive: true, force: true });
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
      await new Promise((r) => setTimeout(r, 0));
      const h = handlers as unknown as SessionRpcHandlers;

      const result = await h.stop({});
      expect(result).toEqual({ ok: true });

      const code = await run;
      expect(code).toBe(0);
      expect(fakeRemote.stop).toHaveBeenCalledOnce();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
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
      await vi.advanceTimersByTimeAsync(0);
      const h = handlers as unknown as SessionRpcHandlers;

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
      await rm(homeDir, { recursive: true, force: true });
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
      await new Promise((r) => setTimeout(r, 0));
      const h = handlers as unknown as SessionRpcHandlers;

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
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
