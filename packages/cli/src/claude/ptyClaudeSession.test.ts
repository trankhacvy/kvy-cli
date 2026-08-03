import type { SessionEnvelope } from "@kvy/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyTerminal,
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

// "improving" this into a visible screen write — OSC 9 is a non-rendering control sequence
// specifically because the provider TUI owns the framebuffer while a session runs.
describe("notifyTerminal", () => {
  it("writes ONLY the OSC 9 + BEL sequence, nothing else", () => {
    const writes: string[] = [];
    notifyTerminal((text) => writes.push(text), "a device wants your keys");

    expect(writes).toEqual(["\x1b]9;a device wants your keys\x07"]);
  });
});

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
  /** Fires and removes only the earliest-still-pending timer; no-op if none. Lets a test advance one scheduled callback (e.g. an injection's submit delay) without also firing a later-scheduled one (e.g. a longer confirm-watcher arm-expiry) that `runAll` would otherwise sweep up too. */
  const runNext = (): void => {
    const first = timers.entries().next().value as [number, () => void] | undefined;
    if (!first) return;
    timers.delete(first[0]);
    first[1]();
  };
  return { setTimeoutImpl, clearTimeoutImpl, runAll, runNext };
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
      return { path: "/tmp/kvy-fetch.sock", close: fetchClose };
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
    launcherPath: "/kvy/launcher.cjs",
    claudeCliPath: "/usr/local/bin/claude",
    claudeArgs: [],
    providerSessionId: null,
    homeDir: "/home/.kvy",
    env: { PATH: "/usr/bin" },
    settingsPath: "/home/.kvy/tmp/hooks/session-hook.json",
    settingsEnv: { KVY_HOOK_SETTINGS_PATH: "/home/.kvy/tmp/hooks/session-hook.json" },
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
    expect(args[0]).toBe("/kvy/launcher.cjs");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    // The --settings path comes from the caller's single shared hook server.
    expect(args.slice(-2)).toEqual(["--settings", "/home/.kvy/tmp/hooks/session-hook.json"]);
    expect(options.cwd).toBe("/work");
    expect(options.cols).toBe(120);
    expect(options.rows).toBe(40);
    expect(options.env.KVY_CLAUDE_PATH).toBe("/usr/local/bin/claude");
    // The hook settings env is merged onto the spawned claude's environment.
    expect(options.env.KVY_HOOK_SETTINGS_PATH).toBe("/home/.kvy/tmp/hooks/session-hook.json");
    expect(options.env.KVY_FETCH_SIGNAL_PATH).toBe("/tmp/kvy-fetch.sock");

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
    expect(options.env.KVY_HOOK_SETTINGS_PATH).toBeUndefined();

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

  it("forwards Claude Code's own transcript summary line to onSummaryTitle, without also emitting it as an envelope", async () => {
    const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
    const onSummaryTitle = vi.fn<(title: string) => void>();
    const h = makeHarness();
    const handle = startPtyClaudeSession(baseOptions({ onEnvelopes, onSummaryTitle }), h.deps);
    await tick();

    const onMessage = h.getScannerOnMessage();
    onMessage?.({
      type: "summary",
      summary: "Fix the login redirect bug",
      leafUuid: "leaf-1",
    } as unknown as RawJSONLines);

    expect(onSummaryTitle).toHaveBeenCalledExactlyOnceWith("Fix the login redirect bug");
    expect(onEnvelopes).not.toHaveBeenCalled();

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

  describe("answerPermission (real two-way remote control — a web decision drives the live PTY dialog)", () => {
    const shiftTab = `${String.fromCharCode(0x1b)}[Z`;
    const enter = "\r";

    it("writes ESC for a deny decision", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "deny" }, "default", "Write")).toBe(true);
      expect(h.fakePty.writes).toEqual([String.fromCharCode(0x1b)]);

      handle.stop();
    });

    it("writes '1' then Enter for an allow-once decision", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "allow", scope: "once" }, "default", "Write")).toBe(
        true,
      );
      expect(h.fakePty.writes).toEqual(["1", enter]);

      handle.stop();
    });

    it("cycles Shift+Tab to acceptEdits then Enter for an allow-session decision", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "allow", scope: "session" }, "default", "Write")).toBe(
        true,
      );
      expect(h.fakePty.writes).toEqual([shiftTab, enter]);

      handle.stop();
    });

    it("cycles Shift+Tab to the requested mode then Enter for a mode decision", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "mode", mode: "plan" }, "default", "Write")).toBe(
        true,
      );
      expect(h.fakePty.writes).toEqual([shiftTab, shiftTab, enter]);

      handle.stop();
    });

    it("treats a missing currentMode as 'default' when computing the Shift+Tab cycle", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "mode", mode: "acceptEdits" }, null, "Write")).toBe(
        true,
      );
      expect(h.fakePty.writes).toEqual([shiftTab, enter]);

      handle.stop();
    });

    it("is NOT gated by an open TUI dialog — unlike sendModeCycle, its whole job is to answer the open dialog", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      handle.setPromptOpen(true);
      expect(handle.answerPermission({ kind: "deny" }, "default", "Write")).toBe(true);
      expect(h.fakePty.writes).toEqual([String.fromCharCode(0x1b)]);

      handle.stop();
    });

    it("reports failure when the pty never spawned", async () => {
      const h = makeHarness();
      h.spawnPty.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "deny" }, "default", "Write")).toBe(false);
    });

    it("writes '2' then Enter for ExitPlanMode's allow-once decision — 'Yes, manually approve edits', NOT digit '1' (live-verified: '1' on this dialog means auto-accept-edits, a mode switch)", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(
        handle.answerPermission({ kind: "allow", scope: "once" }, "default", "ExitPlanMode"),
      ).toBe(true);
      expect(h.fakePty.writes).toEqual(["2", enter]);

      handle.stop();
    });

    it("writes '1' then Enter for ExitPlanMode's allow-session decision — 'Yes, auto-accept edits', no Shift+Tab cycle", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(
        handle.answerPermission({ kind: "allow", scope: "session" }, "default", "ExitPlanMode"),
      ).toBe(true);
      expect(h.fakePty.writes).toEqual(["1", enter]);

      handle.stop();
    });

    it("still writes ESC for ExitPlanMode's deny decision", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerPermission({ kind: "deny" }, "default", "ExitPlanMode")).toBe(true);
      expect(h.fakePty.writes).toEqual([String.fromCharCode(0x1b)]);

      handle.stop();
    });

    it("writes nothing and returns false for a 'mode' decision on ExitPlanMode — its dialog has no general mode picker", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(
        handle.answerPermission(
          { kind: "mode", mode: "bypassPermissions" },
          "default",
          "ExitPlanMode",
        ),
      ).toBe(false);
      expect(h.fakePty.writes).toEqual([]);

      handle.stop();
    });

    it("recognizes the 'exit_plan_mode' tool-name spelling too", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(
        handle.answerPermission({ kind: "allow", scope: "once" }, "default", "exit_plan_mode"),
      ).toBe(true);
      expect(h.fakePty.writes).toEqual(["2", enter]);

      handle.stop();
    });
  });

  describe("answerAskUserQuestion (real two-way remote control for the AskUserQuestion widget)", () => {
    const right = `${String.fromCharCode(0x1b)}[C`;
    const colorQuestion = {
      question: "Which color?",
      options: ["Red", "Blue", "Green"],
    };
    const fruitsQuestion = {
      question: "Pick fruits",
      multiSelect: true,
      options: ["Apple", "Banana", "Cherry"],
    };

    it("writes ESC for a deny decision (the web card's 'Chat about this')", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerAskUserQuestion({ kind: "deny" }, [colorQuestion])).toBe(true);
      expect(h.fakePty.writes).toEqual([String.fromCharCode(0x1b)]);

      handle.stop();
    });

    it("writes ONLY the matching digit for a lone single-select question (no tab bar, no separate Submit step at all)", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      const decision = {
        kind: "allow" as const,
        scope: "once" as const,
        updatedInput: { answers: { "Which color?": "Blue" } },
      };
      expect(handle.answerAskUserQuestion(decision, [colorQuestion])).toBe(true);
      // "Blue" is option 2. A single question with no multi-select has no
      // tab bar at all — the digit press both answers AND submits the whole
      // form immediately (live-verified: a trailing "1" here would instead
      // leak into the next chat prompt as a stray keystroke).
      expect(h.fakePty.writes).toEqual(["2"]);

      handle.stop();
    });

    it("toggles digits then presses Right to reach Submit for a multi-select answer", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      const decision = {
        kind: "allow" as const,
        scope: "once" as const,
        updatedInput: { answers: { "Pick fruits": "Apple, Cherry" } },
      };
      expect(handle.answerAskUserQuestion(decision, [fruitsQuestion])).toBe(true);
      expect(h.fakePty.writes).toEqual(["1", "3", right, "1"]);

      handle.stop();
    });

    it("paces consecutive keystrokes one timer tick apart (live-verified: writing two digits back to back silently dropped the second one)", async () => {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll(); // drain the readyDelay timer only

      const decision = {
        kind: "allow" as const,
        scope: "once" as const,
        updatedInput: { answers: { "Pick fruits": "Apple, Cherry" } },
      };
      expect(handle.answerAskUserQuestion(decision, [fruitsQuestion])).toBe(true);

      // Only the first keystroke is written synchronously — the rest are
      // scheduled, not fired back to back.
      expect(h.fakePty.writes).toEqual(["1"]);

      timers.runNext();
      expect(h.fakePty.writes).toEqual(["1", "3"]);

      timers.runNext();
      expect(h.fakePty.writes).toEqual(["1", "3", right]);

      timers.runNext();
      expect(h.fakePty.writes).toEqual(["1", "3", right, "1"]);

      handle.stop();
    });

    it("handles a mixed multi-question form (single-select then multi-select)", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      const decision = {
        kind: "allow" as const,
        scope: "once" as const,
        updatedInput: {
          answers: { "Which color?": "Red", "Pick fruits": "Banana" },
        },
      };
      expect(handle.answerAskUserQuestion(decision, [colorQuestion, fruitsQuestion])).toBe(true);
      // "Red" (single-select, digit 1) auto-advances to the fruits tab;
      // "Banana" (multi-select, digit 2) needs the explicit Right to Submit.
      expect(h.fakePty.writes).toEqual(["1", "2", right, "1"]);

      handle.stop();
    });

    it("drives a free-text answer that matches no listed option via the widget's own 'Type something' row", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      const decision = {
        kind: "allow" as const,
        scope: "once" as const,
        updatedInput: { answers: { "Which color?": "Purple" } },
      };
      expect(handle.answerAskUserQuestion(decision, [colorQuestion])).toBe(true);
      // colorQuestion has 3 options, so "Type something" is digit "4" — its
      // digit only opens the row for editing (live-verified: it does NOT
      // submit like every other option's digit does), then each typed
      // character replaces its placeholder text, then Enter confirms. A lone
      // free-text question has no separate review tab either, same as a
      // lone matched single-select answer.
      expect(h.fakePty.writes).toEqual(["4", "P", "u", "r", "p", "l", "e", "\r"]);

      handle.stop();
    });

    it("drives a free-text answer anywhere in a multi-question form, then reaches the review tab's Submit", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      const decision = {
        kind: "allow" as const,
        scope: "once" as const,
        updatedInput: {
          answers: { "Which color?": "Red", "Pick fruits": "Durian" },
        },
      };
      expect(handle.answerAskUserQuestion(decision, [colorQuestion, fruitsQuestion])).toBe(true);
      // "Red" (single-select, digit 1) auto-advances to the fruits tab;
      // "Durian" doesn't match any of fruitsQuestion's 3 options, so it's
      // typed into that question's own "Type something" row (digit "4"),
      // confirmed with Enter, then the form's review tab is reached — "1" +
      // Enter (already the trailing "1" a multi-question form always needs).
      expect(h.fakePty.writes).toEqual(["1", "4", "D", "u", "r", "i", "a", "n", "\r", "1"]);

      handle.stop();
    });

    it("reports failure when the pty never spawned", async () => {
      const h = makeHarness();
      h.spawnPty.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.answerAskUserQuestion({ kind: "deny" }, [colorQuestion])).toBe(false);
    });
  });

  describe("sendModelChange (issue #12 — real setModel's /model slash command)", () => {
    it("types /model <alias> then Enter, and reports success when the gate is open", async () => {
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendModelChange("sonnet")).toBe(true);
      expect(h.fakePty.writes).toEqual(["/model sonnet", "\r"]);

      handle.stop();
    });

    it("is gated closed while a TUI dialog is open — same rule as message injection", async () => {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      handle.setPromptOpen(true);
      expect(handle.sendModelChange("opus")).toBe(false);
      expect(h.fakePty.writes).toEqual([]);

      handle.setPromptOpen(false);
      expect(handle.sendModelChange("opus")).toBe(true);
      // Unlike `sendModeCycle`'s direct synchronous `ptyProcess.write`,
      // `sendModelChange` goes through `InjectionController.enqueue` — the
      // submit ("\r") is scheduled `submitDelayMs` after the text write, so
      // the manual timer queue needs another drain to observe it.
      timers.runAll();
      expect(h.fakePty.writes).toEqual(["/model opus", "\r"]);

      handle.stop();
    });

    it("reports failure when the pty never spawned", async () => {
      const h = makeHarness();
      h.spawnPty.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      expect(handle.sendModelChange("haiku")).toBe(false);
    });

    describe("Switch model? confirmation dialog auto-confirm (issue #12 — mid-conversation switches)", () => {
      /**
       * Manual timers throughout this block: the confirm watcher's
       * arm-expiry timer and the injection's submit-delay timer are BOTH
       * scheduled by a single `sendModelChange` call, and `makeHarness()`'s
       * default synchronous `setTimeoutImpl` would fire the arm-expiry timer
       * immediately — disarming the watcher before any PTY data could ever
       * arrive. `timers.runNext()` fires only the earliest-scheduled timer
       * (the submit, enqueued before the watcher arms — see
       * `sendModelChange`'s own comment on that ordering), leaving the
       * arm-expiry timer pending so the watcher stays armed for the
       * assertions below.
       */
      function setup() {
        const h = makeHarness();
        const timers = makeManualTimers();
        h.deps.setTimeoutImpl = timers.setTimeoutImpl;
        h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
        return { h, timers };
      }

      it("auto-confirms with '1' + Enter once Claude Code's confirmation dialog appears in raw PTY output", async () => {
        const { h, timers } = setup();
        const handle = startPtyClaudeSession(baseOptions(), h.deps);
        await tick();
        timers.runAll(); // drain the readyDelay timer

        expect(handle.sendModelChange("sonnet")).toBe(true);
        timers.runNext(); // fire only the submit-delay timer (the "\r")
        expect(h.fakePty.writes).toEqual(["/model sonnet", "\r"]);

        h.fakePty.emitData(
          "Switch model?\nYour next response will be slower and use more tokens\n❯ 1. Yes, switch to Sonnet 5\n  2. No, go back",
        );
        expect(h.fakePty.writes).toEqual(["/model sonnet", "\r", "1", "\r"]);

        handle.stop();
      });

      it("recognizes the dialog text even split across multiple PTY data chunks", async () => {
        const { h, timers } = setup();
        const handle = startPtyClaudeSession(baseOptions(), h.deps);
        await tick();
        timers.runAll();

        expect(handle.sendModelChange("opus")).toBe(true);
        timers.runNext();
        h.fakePty.emitData("Switch mod");
        expect(h.fakePty.writes).toEqual(["/model opus", "\r"]); // not yet — pattern incomplete
        h.fakePty.emitData("el?\n❯ 1. Yes, switch to Opus\n  2. No, go back");
        expect(h.fakePty.writes).toEqual(["/model opus", "\r", "1", "\r"]);

        handle.stop();
      });

      it("sends nothing extra when no confirmation dialog appears — a fresh, history-free session", async () => {
        const { h, timers } = setup();
        const handle = startPtyClaudeSession(baseOptions(), h.deps);
        await tick();
        timers.runAll();

        expect(handle.sendModelChange("haiku")).toBe(true);
        timers.runNext();
        h.fakePty.emitData(
          "  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions\n",
        );
        expect(h.fakePty.writes).toEqual(["/model haiku", "\r"]);

        handle.stop();
      });

      it("stops watching once the arm window expires, ignoring a late-arriving dialog", async () => {
        const { h, timers } = setup();
        const handle = startPtyClaudeSession(baseOptions(), h.deps);
        await tick();
        timers.runAll(); // drain the readyDelay timer only

        expect(handle.sendModelChange("sonnet")).toBe(true);
        timers.runNext(); // fire the submit-delay timer (the "\r")
        timers.runNext(); // fire the confirm-watcher's own arm-expiry timer

        h.fakePty.emitData("Switch model?\n❯ 1. Yes, switch to Sonnet 5\n  2. No, go back");
        expect(h.fakePty.writes).toEqual(["/model sonnet", "\r"]);

        handle.stop();
      });

      it("only arms once per sendModelChange call — a second unrelated dialog-shaped chunk later doesn't double-confirm", async () => {
        const { h, timers } = setup();
        const handle = startPtyClaudeSession(baseOptions(), h.deps);
        await tick();
        timers.runAll();

        expect(handle.sendModelChange("opus")).toBe(true);
        timers.runNext();
        h.fakePty.emitData("Switch model?\n❯ 1. Yes, switch to Opus\n  2. No, go back");
        expect(h.fakePty.writes).toEqual(["/model opus", "\r", "1", "\r"]);

        // The watcher disarmed itself after confirming — an unrelated later
        // chunk that happens to contain the same phrase (however unlikely)
        // must not trigger a second, unsolicited confirm keystroke.
        h.fakePty.emitData("Switch model?\n❯ 1. Yes, switch to Opus\n  2. No, go back");
        expect(h.fakePty.writes).toEqual(["/model opus", "\r", "1", "\r"]);

        handle.stop();
      });
    });
  });

  describe("waitForModeStatus (setMode's faster, hook-independent confirmation signal — text live-verified against real Claude Code v2.1.220)", () => {
    /**
     * Manual timers throughout, same reason as the `sendModelChange` dialog
     * block above: `waitForModeStatus` schedules its own timeout via
     * `setTimeoutImpl`, and `makeHarness()`'s default synchronous timer would
     * fire it immediately — resolving `false` before any PTY data could ever
     * arrive.
     */
    function setup() {
      const h = makeHarness();
      const timers = makeManualTimers();
      h.deps.setTimeoutImpl = timers.setTimeoutImpl;
      h.deps.clearTimeoutImpl = timers.clearTimeoutImpl;
      return { h, timers };
    }

    it("resolves true the instant the live-verified 'default' status text (⏸ manual mode on) appears", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll(); // drain the readyDelay timer

      const result = handle.waitForModeStatus("default", 5000);
      // Live-captured shape: default never gets the "(shift+tab to cycle)"
      // suffix the other two modes do — it ends "· ? for shortcuts" instead.
      h.fakePty.emitData("\x1b[38;5;246m⏸ manual mode on · ? for shortcuts\x1b[39m");
      await expect(result).resolves.toBe(true);

      handle.stop();
    });

    it("resolves true the instant the live-verified 'acceptEdits' status text (⏵⏵ accept edits on) appears", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      const result = handle.waitForModeStatus("acceptEdits", 5000);
      h.fakePty.emitData(
        "\x1b[38;5;147m⏵⏵ accept edits on\x1b[22G\x1b[38;5;246m(shift+tab to cycle)\x1b[39m",
      );
      await expect(result).resolves.toBe(true);

      handle.stop();
    });

    it("resolves true the instant the live-verified 'plan' status text (⏸ plan mode on) appears, even with the trailing hint split by a mid-string cursor jump", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      const result = handle.waitForModeStatus("plan", 5000);
      // Live-captured shape: Claude Code's own renderer sometimes splits the
      // "(shift+tab to cycle)" hint around a cursor-repositioning escape (a
      // partial-redraw diff against the previous frame) — the glyph+phrase
      // prefix `MODE_STATUS_PATTERNS` actually matches on is unaffected.
      h.fakePty.emitData(
        "\x1b[38;5;73m⏸ plan mode on\x1b[38;5;246m (shift+tab \x1b[30Go cycle)\x1b[39m",
      );
      await expect(result).resolves.toBe(true);

      handle.stop();
    });

    it("recognizes the status text even split across multiple PTY data chunks", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      const result = handle.waitForModeStatus("plan", 5000);
      h.fakePty.emitData("\x1b[38;5;73m⏸ plan mode");
      h.fakePty.emitData(" on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m");
      await expect(result).resolves.toBe(true);

      handle.stop();
    });

    it("does not match a different mode's status text — times out false instead of confirming the wrong mode", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      const result = handle.waitForModeStatus("plan", 5000);
      h.fakePty.emitData(
        "\x1b[38;5;147m⏵⏵ accept edits on\x1b[22G\x1b[38;5;246m(shift+tab to cycle)\x1b[39m",
      );
      timers.runAll(); // fire the watcher's own timeout — nothing matched "plan"
      await expect(result).resolves.toBe(false);

      handle.stop();
    });

    it("resolves false once timeoutMs elapses with no matching output at all", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      const result = handle.waitForModeStatus("plan", 5000);
      timers.runAll();
      await expect(result).resolves.toBe(false);

      handle.stop();
    });

    it("resolves false immediately for bypassPermissions — live-verified unreachable via Shift+Tab, no status text to ever watch for", async () => {
      const { h } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();

      await expect(handle.waitForModeStatus("bypassPermissions", 5000)).resolves.toBe(false);

      handle.stop();
    });

    it("a second call supersedes the first — the stale watcher resolves false immediately rather than waiting out its own timeout", async () => {
      const { h, timers } = setup();
      const handle = startPtyClaudeSession(baseOptions(), h.deps);
      await tick();
      timers.runAll();

      const first = handle.waitForModeStatus("plan", 5000);
      const second = handle.waitForModeStatus("acceptEdits", 5000);
      h.fakePty.emitData(
        "\x1b[38;5;147m⏵⏵ accept edits on\x1b[22G\x1b[38;5;246m(shift+tab to cycle)\x1b[39m",
      );

      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(true);

      handle.stop();
    });
  });

  describe("closeTurn (proactive turn-end)", () => {
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
      // Reproduces the live-confirmed race: the `Stop`
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
      // closeTurn checks state. Only the FIRST flush finds anything; the
      // two quiet flushes closeTurn requires after that use the default
      // (no-op) mock implementation.
      h.scannerFlush.mockImplementationOnce(async () => {
        const onMessage = h.getScannerOnMessage();
        onMessage?.({
          type: "assistant",
          uuid: "a-1",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        } as unknown as RawJSONLines);
      });

      await handle.closeTurn("completed");

      // 1 flush that finds the message + 2 consecutive quiet flushes
      // (CLOSE_TURN_QUIET_FLUSHES_REQUIRED) before closeTurn trusts it.
      expect(h.scannerFlush).toHaveBeenCalledTimes(3);
      // Two calls: the assistant message's own turn-start+text (emitted by
      // flush's simulated onMessage above), then closeTurn's turn-end.
      expect(onEnvelopes).toHaveBeenCalledTimes(2);
      const allEnvelopes = onEnvelopes.mock.calls.flatMap(
        ([envelopes]) => envelopes as SessionEnvelope[],
      );
      expect(allEnvelopes.some((e) => e.ev.t === "turn-end")).toBe(true);

      handle.stop();
    });

    it("does not close after a single quiet flush while a tool-use turn's final reply is still being written (live-confirmed regression)", async () => {
      // A tool-using turn opens (currentTurnId becomes non-null) at the
      // FIRST assistant entry — long before the model's final text reply is
      // written. Confirmed live: trusting a single quiet flush closed the
      // turn right after the tool call, silently orphaning the reply that
      // landed moments later in a turn that never got its own turn-end.
      // Simulates exactly that: flush #1 is quiet (tool-use entries were
      // already ingested earlier, nothing NEW this pass) even though the
      // turn is still genuinely in progress; flush #2 is where the final
      // reply actually shows up.
      const onEnvelopes = vi.fn<(envelopes: SessionEnvelope[]) => void>();
      const h = makeHarness();
      const handle = startPtyClaudeSession(baseOptions({ onEnvelopes }), h.deps);
      await tick();

      // Turn already open from an earlier tool-use message the regular
      // tailer (not flush) already ingested.
      const onMessage = h.getScannerOnMessage();
      onMessage?.({
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-1", name: "Bash", input: { command: "sleep 1" } },
          ],
        },
      } as unknown as RawJSONLines);
      onEnvelopes.mockClear();

      let flushCall = 0;
      h.scannerFlush.mockImplementation(async () => {
        flushCall++;
        if (flushCall === 2) {
          // The final reply lands on the SECOND flush, not the first.
          h.getScannerOnMessage()?.({
            type: "assistant",
            uuid: "a-2",
            message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          } as unknown as RawJSONLines);
        }
      });

      await handle.closeTurn("completed");

      // Must have kept flushing past the first quiet reading to catch the
      // reply that arrived on flush #2, then required two MORE consecutive
      // quiet flushes (#3, #4) before finally closing.
      expect(h.scannerFlush).toHaveBeenCalledTimes(4);
      const allEnvelopes = onEnvelopes.mock.calls.flatMap(
        ([envelopes]) => envelopes as SessionEnvelope[],
      );
      // The reply text must be in the SAME turn as the turn-end — not
      // orphaned in a turn that got closed before the text ever arrived.
      expect(allEnvelopes.some((e) => e.ev.t === "text" && e.ev.md === "done")).toBe(true);
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
