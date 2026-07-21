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

/**
 * A manual timer queue — unlike `makeHarness()`'s own `setTimeoutImpl` (which
 * fires synchronously, fine for tests that only care about end-state), tests
 * that need to observe an in-between state (a local draft still active, an
 * injection still mid-flight, a promptOpen gate not yet self-cleared) need
 * control over exactly when a scheduled callback runs.
 */
function makeManualTimers() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  const setTimeoutImpl = (fn: () => void): ReturnType<typeof setTimeout> => {
    const id = ++seq;
    timers.set(id, fn);
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutImpl = (handle: ReturnType<typeof setTimeout>): void => {
    timers.delete(handle as unknown as number);
  };
  const runAll = (): void => {
    let guard = 0;
    while (timers.size > 0 && guard++ < 100) {
      const first = timers.entries().next().value as [number, () => void];
      timers.delete(first[0]);
      first[1]();
    }
  };
  return { setTimeoutImpl, clearTimeoutImpl, runAll };
}

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
  scannerFlush: ReturnType<typeof vi.fn>;
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
  const scannerFlush = vi.fn(async () => {});
  let scannerOnMessage: ((raw: RawJSONLines) => void) | null = null;
  const createSessionScanner = vi.fn(async (opts: { onMessage: (raw: RawJSONLines) => void }) => {
    scannerOnMessage = opts.onMessage;
    return { cleanup: scannerCleanup, onNewSession: scannerOnNewSession, flush: scannerFlush };
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
    scannerFlush,
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

  describe("local-submit detection (W1.2)", () => {
    it("fires onLocalSubmit on a real Enter typed at the terminal", async () => {
      const onLocalSubmit = vi.fn();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onLocalSubmit }), h.deps);
      await tick();

      h.stdin.emitData(Buffer.from("\r", "utf8"));
      expect(onLocalSubmit).toHaveBeenCalledOnce();
      // Still forwarded to the PTY like any other keystroke.
      expect(h.fakePty.writes).toContain("\r");

      handle.stop();
    });

    it("also fires on a bare newline, not just carriage return", async () => {
      const onLocalSubmit = vi.fn();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onLocalSubmit }), h.deps);
      await tick();

      h.stdin.emitData(Buffer.from("\n", "utf8"));
      expect(onLocalSubmit).toHaveBeenCalledOnce();

      handle.stop();
    });

    it("does not fire for ordinary typing", async () => {
      const onLocalSubmit = vi.fn();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onLocalSubmit }), h.deps);
      await tick();

      h.stdin.emitData(Buffer.from("ls -la", "utf8"));
      expect(onLocalSubmit).not.toHaveBeenCalled();

      handle.stop();
    });

    it("suppresses local-submit detection while a queued web message is mid-injection", async () => {
      const onLocalSubmit = vi.fn();
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions({ onLocalSubmit }), h.deps);
      await tick();
      timers.runAll(); // fire the ready timer

      handle.injectMessage({ id: "m1", text: "hi" }); // text written, submit timer pending
      h.stdin.emitData(Buffer.from("\r", "utf8")); // a real Enter racing in mid-injection
      expect(onLocalSubmit).not.toHaveBeenCalled();

      timers.runAll(); // the submit timer fires — injection completes
      h.stdin.emitData(Buffer.from("\r", "utf8")); // now a genuine local submit
      expect(onLocalSubmit).toHaveBeenCalledOnce();

      handle.stop();
    });
  });

  describe("local-draft gating (W1.3)", () => {
    it("gates a queued injection while the human is composing, flushing once the draft goes idle", async () => {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll(); // ready timer

      h.stdin.emitData(Buffer.from("h", "utf8")); // printable char — starts a draft
      handle.injectMessage({ id: "m1", text: "web message" });
      expect(h.fakePty.writes).not.toContain("web message");

      timers.runAll(); // the draft-idle timer elapses
      expect(h.fakePty.writes).toContain("web message");

      handle.stop();
    });

    it("clears the draft immediately on a local Enter, releasing the queued injection", async () => {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      h.stdin.emitData(Buffer.from("done typing", "utf8"));
      handle.injectMessage({ id: "m1", text: "web message" });
      expect(h.fakePty.writes).not.toContain("web message");

      h.stdin.emitData(Buffer.from("\r", "utf8"));
      expect(h.fakePty.writes).toContain("web message");

      handle.stop();
    });

    it("clears the draft on a local Escape too", async () => {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      h.stdin.emitData(Buffer.from("half a message", "utf8"));
      handle.injectMessage({ id: "m1", text: "web message" });
      expect(h.fakePty.writes).not.toContain("web message");

      h.stdin.emitData(Buffer.from("\x1b", "utf8"));
      expect(h.fakePty.writes).toContain("web message");

      handle.stop();
    });
  });

  describe("setPromptOpen (W1.3)", () => {
    it("gates a queued injection through the controller and releases it once cleared", async () => {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      handle.setPromptOpen(true);
      handle.injectMessage({ id: "m1", text: "blocked by dialog" });
      expect(h.fakePty.writes).not.toContain("blocked by dialog");

      handle.setPromptOpen(false);
      expect(h.fakePty.writes).toContain("blocked by dialog");

      handle.stop();
    });
  });

  describe("onDroppedInjections (W3.9)", () => {
    it("reports still-queued (never-injected) messages when the session ends while claude is busy", async () => {
      const onDroppedInjections = vi.fn();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onDroppedInjections }), h.deps);
      await tick();

      // Mark busy via the fetch-signal path so the queued message is never
      // typed into the PTY at all.
      h.emitFetch({ type: "fetch-start", id: 1 });
      handle.injectMessage({ id: "m1", text: "never delivered" });
      expect(h.fakePty.writes).not.toContain("never delivered");

      h.fakePty.emitExit(0);
      await handle.done;

      expect(onDroppedInjections).toHaveBeenCalledExactlyOnceWith([
        { id: "m1", text: "never delivered" },
      ]);
    });

    it("reports a message dropped mid-injection (text written, submit not yet sent) when the child exits first", async () => {
      const onDroppedInjections = vi.fn();
      const onInjected = vi.fn();
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(
        baseOptions({ onDroppedInjections, onInjected }),
        h.deps,
      );
      await tick();
      timers.runAll(); // fire the ready timer

      handle.injectMessage({ id: "m1", text: "in flight" });
      // Text already written; the submit timer is pending (manual timers, not
      // yet run) — mirrors the real "written but not yet submitted" window.
      expect(h.fakePty.writes).toEqual(["in flight"]);

      h.fakePty.emitExit(0); // the child exits before the submit keystroke
      await handle.done;

      // dispose() ran as part of teardown but the pending submit timer isn't
      // cleared (by design — see injectionController.ts's dispose() doc) so
      // it can still report the mid-injection message once it fires.
      expect(onDroppedInjections).not.toHaveBeenCalled();
      timers.runAll();

      expect(h.fakePty.writes).toEqual(["in flight"]); // submit (\r) never sent
      expect(onInjected).not.toHaveBeenCalled();
      expect(onDroppedInjections).toHaveBeenCalledExactlyOnceWith([
        { id: "m1", text: "in flight" },
      ]);
    });
  });

  describe("sendInterrupt (W1.5)", () => {
    it("writes a single ESC into the PTY and reports success", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendInterrupt()).toBe(true);
      expect(h.fakePty.writes).toContain(String.fromCharCode(0x1b));

      handle.stop();
    });

    it("reports failure when the pty never spawned", async () => {
      const h = makeHarness();
      h.spawnPty.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendInterrupt()).toBe(false);
    });
  });

  describe("sendModeCycle (W4.3 — real setMode's Shift+Tab keystroke cycle)", () => {
    const shiftTab = `${String.fromCharCode(0x1b)}[Z`;

    it("writes N Shift+Tab keystrokes and reports success when the gate is open", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendModeCycle(3)).toBe(true);
      expect(h.fakePty.writes).toEqual([shiftTab, shiftTab, shiftTab]);

      handle.stop();
    });

    it("returns false and writes nothing for zero or negative presses", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendModeCycle(0)).toBe(false);
      expect(handle.sendModeCycle(-1)).toBe(false);
      expect(h.fakePty.writes).toEqual([]);

      handle.stop();
    });

    it("is gated closed while a TUI dialog is open — same rule as message injection", async () => {
      const h = makeHarness();
      // Manual timers: `makeHarness()`'s default `setTimeoutImpl` fires
      // synchronously, which would immediately fire `setPromptOpen(true)`'s
      // own 120s failsafe timer too (same reasoning as the `setPromptOpen
      // (W1.3)` describe block above) — drain the readyDelay timer once via
      // `runAll()`, then everything after stays manually controlled.
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      handle.setPromptOpen(true);
      expect(handle.sendModeCycle(1)).toBe(false);
      expect(h.fakePty.writes).toEqual([]);

      handle.setPromptOpen(false);
      expect(handle.sendModeCycle(1)).toBe(true);
      expect(h.fakePty.writes).toEqual([shiftTab]);

      handle.stop();
    });

    it("reports failure when the pty never spawned", async () => {
      const h = makeHarness();
      h.spawnPty.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendModeCycle(2)).toBe(false);
    });
  });

  describe("closeTurn (docs/user-flows.md fix-plan task 1 — proactive turn-end)", () => {
    it("force-closes the currently open turn, reusing the same tailer mapper state onEnvelopes is driven from", async () => {
      const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
      await tick();

      const onMessage = h.getScannerOnMessage();
      onMessage?.({
        type: "assistant",
        uuid: "a-1",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as unknown as RawJSONLines);
      onEnvelopes.mockClear();

      await handle.closeTurn("completed");

      expect(onEnvelopes).toHaveBeenCalledOnce();
      const [envelopes] = onEnvelopes.mock.calls[0] as [SessionEnvelope[]];
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({ ev: { t: "turn-end", status: "completed" } });

      handle.stop();
    });

    it("flushes the scanner before checking turn state, so a Stop hook that fires before the periodic poll has read the assistant's message still closes the turn", async () => {
      // Reproduces the live-confirmed race (docs/user-flows.md): the `Stop`
      // hook can fire before the transcript poll has ever ingested the
      // assistant's just-written message, so `mapperState` doesn't consider
      // any turn open yet at the instant `closeTurn` is called. `flush()`
      // must run first and its result must be awaited before the mapper
      // state is checked, or this silently no-ops exactly like it did live.
      const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
      await tick();

      // The scanner hasn't "seen" the assistant message yet (no onMessage
      // call) — flush() is what's responsible for making that happen before
      // closeTurn checks state.
      h.scannerFlush.mockImplementationOnce(async () => {
        const onMessage = h.getScannerOnMessage();
        onMessage?.({
          type: "assistant",
          uuid: "a-1",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        } as unknown as RawJSONLines);
      });

      await handle.closeTurn("completed");

      expect(h.scannerFlush).toHaveBeenCalledOnce();
      // Two calls: the assistant message's own turn-start+text (emitted by
      // flush's simulated onMessage above), then closeTurn's turn-end.
      expect(onEnvelopes).toHaveBeenCalledTimes(2);
      const allEnvelopes = onEnvelopes.mock.calls.flatMap(
        ([envelopes]) => envelopes as SessionEnvelope[],
      );
      expect(allEnvelopes.some((e) => e.ev.t === "turn-end")).toBe(true);

      handle.stop();
    });

    it("is a no-op when no turn is currently open", async () => {
      const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
      await tick();

      await handle.closeTurn("completed");
      expect(onEnvelopes).not.toHaveBeenCalled();

      handle.stop();
    });

    it("is a no-op when called before the tailer's async setup has assigned its mapper state", async () => {
      const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
      // Called synchronously, before run()'s async scanner setup resolves.
      await handle.closeTurn("completed");
      expect(onEnvelopes).not.toHaveBeenCalled();

      await tick();
      handle.stop();
    });

    it("does not re-close (and emits nothing) on a second call once already closed", async () => {
      const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
      await tick();

      const onMessage = h.getScannerOnMessage();
      onMessage?.({
        type: "assistant",
        uuid: "a-1",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as unknown as RawJSONLines);
      onEnvelopes.mockClear();

      await handle.closeTurn("completed");
      expect(onEnvelopes).toHaveBeenCalledOnce();
      onEnvelopes.mockClear();

      await handle.closeTurn("completed");
      expect(onEnvelopes).not.toHaveBeenCalled();

      handle.stop();
    });
  });
});
