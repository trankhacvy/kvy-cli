import type { SessionEnvelope } from "@falcon/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PtyClaudeSessionDeps,
  type PtyClaudeSessionOptions,
  type PtyLike,
  type StdinLike,
  type StdoutLike,
  startPtyClaudeSession,
} from "./ptyClaudeSession.js";
import type { RawJSONLines } from "./types.js";

/** Lets pending microtasks (the async `run()` setup) settle. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeFakePty() {
  const dataListeners: Array<(d: string) => void> = [];
  const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  const writes: string[] = [];
  const resize = vi.fn();
  const kill = vi.fn();
  const pty: PtyLike = {
    pid: 4242,
    onData: (cb) => {
      dataListeners.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb) => {
      exitListeners.push(cb);
      return { dispose: () => {} };
    },
    write: (d) => {
      writes.push(d);
    },
    resize,
    kill,
  };
  return {
    pty,
    writes,
    resize,
    kill,
    emitData: (d: string) =>
      dataListeners.forEach((f) => {
        f(d);
      }),
    emitExit: (code: number) =>
      exitListeners.forEach((f) => {
        f({ exitCode: code });
      }),
  };
}

function makeFakeStdin() {
  const listeners: Array<(b: Buffer) => void> = [];
  const setRawMode = vi.fn();
  const resume = vi.fn();
  const pause = vi.fn();
  const stdin: StdinLike = {
    isTTY: true,
    setRawMode,
    resume,
    pause,
    on: (_event, listener) => {
      listeners.push(listener);
    },
    removeListener: (_event, listener) => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    stdin,
    setRawMode,
    resume,
    pause,
    emitData: (b: Buffer) =>
      listeners.slice().forEach((f) => {
        f(b);
      }),
  };
}

function makeFakeStdout() {
  const writes: string[] = [];
  const resizeListeners: Array<() => void> = [];
  const stdout: StdoutLike = {
    columns: 120,
    rows: 40,
    write: (d) => {
      writes.push(d);
      return true;
    },
    on: (_event, listener) => {
      resizeListeners.push(listener);
    },
    removeListener: () => {},
  };
  return {
    stdout,
    writes,
    emitResize: () =>
      resizeListeners.forEach((f) => {
        f();
      }),
  };
}

interface Harness {
  spawnPty: ReturnType<typeof vi.fn>;
  fakePty: ReturnType<typeof makeFakePty>;
  stdin: ReturnType<typeof makeFakeStdin>;
  stdout: ReturnType<typeof makeFakeStdout>;
  scannerCleanup: ReturnType<typeof vi.fn>;
  scannerOnNewSession: ReturnType<typeof vi.fn>;
  getScannerOnMessage: () => ((raw: RawJSONLines) => void) | null;
  fetchClose: ReturnType<typeof vi.fn>;
  emitFetch: (event: { type: "fetch-start" | "fetch-end"; id: number }) => void;
  deps: PtyClaudeSessionDeps;
}

function makeHarness(): Harness {
  const fakePty = makeFakePty();
  const spawnPty = vi.fn(() => fakePty.pty);
  const stdin = makeFakeStdin();
  const stdout = makeFakeStdout();

  const scannerCleanup = vi.fn(async () => {});
  const scannerOnNewSession = vi.fn(async () => {});
  let scannerOnMessage: ((raw: RawJSONLines) => void) | null = null;
  const createSessionScanner = vi.fn(async (opts: { onMessage: (raw: RawJSONLines) => void }) => {
    scannerOnMessage = opts.onMessage;
    return { cleanup: scannerCleanup, onNewSession: scannerOnNewSession };
  }) as unknown as NonNullable<PtyClaudeSessionDeps["createSessionScanner"]>;

  const fetchClose = vi.fn(async () => {});
  let fetchOnEvent: ((e: { type: "fetch-start" | "fetch-end"; id: number }) => void) | null = null;
  const createFetchSignalServer = vi.fn(
    async (opts: { onEvent: (e: { type: "fetch-start" | "fetch-end"; id: number }) => void }) => {
      fetchOnEvent = opts.onEvent;
      return { path: "/tmp/falcon-fetch.sock", close: fetchClose };
    },
  ) as unknown as NonNullable<PtyClaudeSessionDeps["createFetchSignalServer"]>;

  // Timers run synchronously so ready/submit/cooldown/idle-debounce collapse
  // deterministically — the injection *gating* is unit-tested separately in
  // injectionController.test.ts; here we only assert the wiring.
  const setTimeoutImpl: NonNullable<PtyClaudeSessionDeps["setTimeoutImpl"]> = (fn) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };

  const deps: PtyClaudeSessionDeps = {
    spawnPty,
    stdin: stdin.stdin,
    stdout: stdout.stdout,
    createSessionScanner,
    createFetchSignalServer,
    findLastSession: () => null,
    readyDelayMs: 0,
    busyDebounceMs: 0,
    submitDelayMs: 0,
    postSubmitCooldownMs: 0,
    setTimeoutImpl,
  };

  return {
    spawnPty,
    fakePty,
    stdin,
    stdout,
    scannerCleanup,
    scannerOnNewSession,
    getScannerOnMessage: () => scannerOnMessage,
    fetchClose,
    emitFetch: (event) => fetchOnEvent?.(event),
    deps,
  };
}

function baseOptions(overrides: Partial<PtyClaudeSessionOptions> = {}): PtyClaudeSessionOptions {
  return {
    workingDirectory: "/work",
    launcherPath: "/falcon/launcher.cjs",
    claudeCliPath: "/usr/local/bin/claude",
    claudeArgs: [],
    providerSessionId: null,
    homeDir: "/home/.falcon",
    env: { PATH: "/usr/bin" },
    settingsPath: "/home/.falcon/tmp/hooks/session-hook.json",
    settingsEnv: { FALCON_HOOK_SETTINGS_PATH: "/home/.falcon/tmp/hooks/session-hook.json" },
    onEnvelopes: () => {},
    ...overrides,
  };
}

describe("startPtyClaudeSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns claude on the PTY via the launcher with the caller-supplied hook --settings file and fetch-signal env", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions({ claudeArgs: ["--model", "opus"] }), h.deps);
    await tick();

    expect(h.spawnPty).toHaveBeenCalledOnce();
    const [file, args, options] = h.spawnPty.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
    ];
    expect(file).toBe("node");
    expect(args[0]).toBe("/falcon/launcher.cjs");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    // The --settings path comes from the caller's single shared hook server.
    expect(args.slice(-2)).toEqual(["--settings", "/home/.falcon/tmp/hooks/session-hook.json"]);
    expect(options.cwd).toBe("/work");
    expect(options.cols).toBe(120);
    expect(options.rows).toBe(40);
    expect(options.env.FALCON_CLAUDE_PATH).toBe("/usr/local/bin/claude");
    // The hook settings env is merged onto the spawned claude's environment.
    expect(options.env.FALCON_HOOK_SETTINGS_PATH).toBe("/home/.falcon/tmp/hooks/session-hook.json");
    expect(options.env.FALCON_FETCH_SIGNAL_PATH).toBe("/tmp/falcon-fetch.sock");

    handle.stop();
  });

  it("omits --settings when no hook settings path was supplied (hook install failed)", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(
      baseOptions({ settingsPath: null, settingsEnv: undefined }),
      h.deps,
    );
    await tick();

    const [, args, options] = h.spawnPty.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(args).not.toContain("--settings");
    expect(options.env.FALCON_HOOK_SETTINGS_PATH).toBeUndefined();

    handle.stop();
  });

  it("puts the real stdin in raw mode and pipes it both ways", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    await tick();

    expect(h.stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(h.stdin.resume).toHaveBeenCalled();

    // PTY output → stdout.
    h.fakePty.emitData("\x1b[2Jclaude tui");
    expect(h.stdout.writes).toContain("\x1b[2Jclaude tui");

    // Real keystrokes → PTY.
    h.stdin.emitData(Buffer.from("ls -la\r", "utf8"));
    expect(h.fakePty.writes).toContain("ls -la\r");

    handle.stop();
  });

  it("types an injected web message into the PTY when idle and completes it via onInjected", async () => {
    const onInjected = vi.fn();
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions({ onInjected }), h.deps);
    await tick();

    handle.injectMessage({ id: "m1", text: "please refactor foo()" });

    // Text typed, then the Enter (\r) submit — exactly like a human typing.
    expect(h.fakePty.writes).toEqual(["please refactor foo()", "\r"]);
    expect(onInjected).toHaveBeenCalledExactlyOnceWith("m1");

    handle.stop();
  });

  it("holds an injected message while claude is mid-turn (fetch-start) and types it once idle", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    await tick();

    h.emitFetch({ type: "fetch-start", id: 1 });
    handle.injectMessage({ id: "m1", text: "queued mid-turn" });
    expect(h.fakePty.writes).not.toContain("queued mid-turn");

    h.emitFetch({ type: "fetch-end", id: 1 });
    expect(h.fakePty.writes).toContain("queued mid-turn");

    handle.stop();
  });

  it("mirrors transcript entries: scanner onMessage → mapped envelopes → onEnvelopes", async () => {
    const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
    await tick();

    const onMessage = h.getScannerOnMessage();
    expect(onMessage).toBeTypeOf("function");
    onMessage?.({
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: "hello from the transcript" },
    } as unknown as RawJSONLines);

    expect(onEnvelopes).toHaveBeenCalledOnce();
    const [envelopes] = onEnvelopes.mock.calls[0] as [SessionEnvelope[]];
    expect(envelopes[0]).toMatchObject({
      role: "user",
      ev: { t: "text", md: "hello from the transcript" },
    });

    handle.stop();
  });

  it("routes a notified provider session id (from the caller's shared hook server) to the tailer", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    await tick();

    handle.notifyProviderSessionId("11111111-2222-3333-4444-555555555555");
    expect(h.scannerOnNewSession).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555");

    handle.stop();
  });

  it("buffers a provider session id notified before the tailer is up, then applies it", async () => {
    const h = makeHarness();
    // Notify synchronously, before `run()`'s async scanner setup has resolved.
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    handle.notifyProviderSessionId("aaaaaaaa-1111-2222-3333-444444444444");
    await tick();

    expect(h.scannerOnNewSession).toHaveBeenCalledWith("aaaaaaaa-1111-2222-3333-444444444444");

    handle.stop();
  });

  it("propagates terminal resize to the pty", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    await tick();

    h.stdout.stdout.columns = 200;
    h.stdout.stdout.rows = 50;
    h.stdout.emitResize();
    expect(h.fakePty.resize).toHaveBeenCalledWith(200, 50);

    handle.stop();
  });

  it("resolves done with the exit code and tears everything down when claude exits", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    await tick();

    h.fakePty.emitExit(7);
    await expect(handle.done).resolves.toBe(7);

    expect(h.scannerCleanup).toHaveBeenCalled();
    expect(h.fetchClose).toHaveBeenCalled();
    // The hook server + its --settings file are owned by the caller's
    // `installRemotePermissionHook()` composition, torn down there — not here.
    // Terminal restored.
    expect(h.stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(h.stdin.pause).toHaveBeenCalled();
  });

  it("resolves a --resume passthrough into an explicit --resume <id> in hook mode", async () => {
    const h = makeHarness();
    // findLastSession returns a concrete id for a bare --continue.
    h.deps.findLastSession = () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const handle = startPtyClaudeSession(baseOptions({ claudeArgs: ["--continue"] }), h.deps);
    await tick();

    const [, args] = h.spawnPty.mock.calls[0] as [string, string[]];
    expect(args).toContain("--resume");
    expect(args).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(h.scannerOnNewSession).toHaveBeenCalledWith("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
      treatExistingAsProcessed: true,
    });

    handle.stop();
  });

  it("stop() kills the pty child", async () => {
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions(), h.deps);
    await tick();

    handle.stop();
    expect(h.fakePty.kill).toHaveBeenCalledOnce();
  });
});
