/**
 * PTY-injection Claude session — the terminal-attached `falcon claude` input
 * path (the "omnara model"; design §7, replaces the legacy mode-switch
 * takeover for sessions that have a real terminal).
 *
 * ## What this replaces and why
 * The v1 local path spawned the real `claude` CLI with `stdio: 'inherit'` and
 * could only OBSERVE it (via the transcript tailer). To accept a web-sent
 * message it had to KILL the interactive `claude` and take over with a
 * headless remote turn that rendered an Ink "remote mode" status view —
 * destroying the normal TUI (no typing, no slash commands). That takeover is
 * the #1 UX complaint.
 *
 * Instead, this module runs `claude` on a **pseudo-terminal**:
 *  1. `claude` renders its **normal TUI**, always. The user's real stdin is
 *     forwarded (raw mode) to the PTY master, so typing and slash commands
 *     feel exactly normal; PTY output is forwarded to stdout; SIGWINCH-style
 *     resizes are propagated to the pty.
 *  2. A message arriving from the web (`injectMessage`) is **typed into the
 *     same PTY** — text, then a submit key — as if the user typed it. No mode
 *     switch, no process kill, no Ink takeover, ever. Timing is gated by
 *     `InjectionController` off the launcher's idle/busy signal.
 *  3. Mirroring to the web is UNCHANGED: the transcript tailer
 *     (`scanner.ts` → `mapClaudeToEnvelopes` → `onEnvelopes` → outbox) keeps
 *     producing structured envelopes for the web timeline.
 *
 * ## The idle/busy signal under a PTY
 * The launcher (`falcon_claude_launcher.cjs`) instruments `global.fetch` and
 * emits `fetch-start`/`fetch-end` JSON lines. A PTY child has no spare fd 3,
 * so those lines are delivered over a unix-domain socket this module listens
 * on (path passed as `FALCON_FETCH_SIGNAL_PATH`). The same debounce
 * `claudeLocal.ts` uses for its "thinking" indicator turns them into a clean
 * busy/idle edge for the `InjectionController`. Native-binary Claude installs
 * can't be fetch-instrumented in-process (documented launcher limitation) —
 * there the busy edge never fires and injection is gated by the post-submit
 * cooldown alone.
 *
 * ## Permission / lifecycle-hook seam (owned by the caller, not this module)
 * There is exactly ONE hook server per session, and this module does NOT own
 * it. The terminal `falcon claude` flow installs a single hook server (via
 * `remotePermissionHook.ts`'s `installRemotePermissionHook()`) that owns all
 * four Claude Code hooks — `SessionStart` (real provider session id),
 * `Notification`/`Stop` (attention + turn-end), and `PreToolUse` (remote
 * permission answering while the TUI stays live). That composition hands this
 * module two things:
 *  - `settingsPath`/`settingsEnv` — merged into the PTY-spawned `claude`'s
 *    args (`--settings <path>`) + env (`FALCON_HOOK_SETTINGS_PATH`) so every
 *    hook fires.
 *  - the provider session id, forwarded in via `notifyProviderSessionId()` on
 *    the returned handle, which this module routes to the transcript tailer
 *    (`scanner.onNewSession`) exactly as the old self-owned hook server did.
 * This module never starts its own hook server — running two would double the
 * hooks and race the session-id/attention signals.
 */

import type { SessionEnvelope } from "@falcon/wire";
import { spawn as spawnPtyDefault } from "node-pty";
import type { Logger } from "../logger.js";
import { FALCON_SYSTEM_PROMPT, findLastLocalSession, resolveSessionFlags } from "./claudeLocal.js";
import { createClaudeEnvelopeMapperState, mapClaudeToEnvelopes } from "./envelopeMapper.js";
import { InjectionController, type PendingInjection } from "./injectionController.js";
import {
  createFetchSignalServer as createFetchSignalServerDefault,
  type FetchSignalEvent,
  type FetchSignalServer,
} from "./ptyFetchSignal.js";
import {
  createSessionScanner as createSessionScannerDefault,
  type SessionScanner,
} from "./scanner.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** How long after the last active fetch ends before `busy` flips back to idle (mirrors `claudeLocal.ts`). */
const DEFAULT_BUSY_DEBOUNCE_MS = 500;
/** Grace period after spawn before the first web message may be typed in (lets the TUI paint its prompt). */
const DEFAULT_READY_DELAY_MS = 1500;
/** How long a local draft may sit idle before the injection gate assumes it was abandoned (plan-v2.md W1.3). */
const DRAFT_IDLE_MS = 15_000;
const DEFAULT_PTY_NAME = "xterm-256color";
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** The submit keystroke — a carriage return, the same byte a real Enter sends on a TTY. */
const SUBMIT_KEY = "\r";

/** The minimal `IPty` surface this module drives — node-pty's `IPty` satisfies it structurally. */
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Options node-pty's `spawn` accepts that this module sets. */
export interface SpawnPtyOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The real terminal stdin surface this module reads (a subset of `tty.ReadStream`). */
export interface StdinLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (data: Buffer) => void): void;
  removeListener(event: "data", listener: (data: Buffer) => void): void;
}

/** The real terminal stdout surface this module writes (a subset of `tty.WriteStream`). */
export interface StdoutLike {
  columns?: number;
  rows?: number;
  write(data: string): boolean;
  on(event: "resize", listener: () => void): void;
  removeListener(event: "resize", listener: () => void): void;
}

export interface PtyClaudeSessionOptions {
  workingDirectory: string;
  /** Resolved path to `scripts/falcon_claude_launcher.cjs`. */
  launcherPath: string;
  /** Resolved real path to the `claude` CLI (passed to the launcher as `FALCON_CLAUDE_PATH`). */
  claudeCliPath: string;
  /** Provider passthrough args (never mutated). */
  claudeArgs: string[];
  /** Provider (Claude Code) session id to resume, or null for fresh/whatever-claudeArgs-says. */
  providerSessionId: string | null;
  /** `~/.falcon` (or override) — hosts the fetch-signal socket + temp dirs. */
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Path to the shared hook `--settings` file (owned by the caller's single
   * `installRemotePermissionHook()` composition). Passed to the PTY-spawned
   * `claude` as `--settings <path>` so all four hooks fire. Null/undefined
   * when the hook server failed to install (session runs without hooks).
   */
  settingsPath?: string | null;
  /**
   * Env vars carrying the hook settings path onto the spawned `claude`'s
   * environment (`{ FALCON_HOOK_SETTINGS_PATH: <path> }`) — merged into the
   * PTY child's env. From the same composition as `settingsPath`.
   */
  settingsEnv?: Record<string, string>;
  /** Every envelope the tailer maps off the transcript. Forward to the outbox. */
  onEnvelopes: (envelopes: SessionEnvelope[]) => void;
  /** Fires once a web-injected message has actually been submitted — the §7.10 send-claim completion hook. */
  onInjected?: (id: string) => void;
  /** Fires when the human at the real terminal submits input (Enter outside injection) — plan-v2.md W1.2. */
  onLocalSubmit?: () => void;
  logger?: Logger;
}

export interface PtyClaudeSessionDeps {
  /** Injectable for tests; defaults to node-pty's `spawn`. */
  spawnPty?: (file: string, args: string[], options: SpawnPtyOptions) => PtyLike;
  /** Injectable for tests; defaults to `process.stdin`. */
  stdin?: StdinLike;
  /** Injectable for tests; defaults to `process.stdout`. */
  stdout?: StdoutLike;
  createSessionScanner?: typeof createSessionScannerDefault;
  createFetchSignalServer?: typeof createFetchSignalServerDefault;
  findLastSession?: (workingDirectory: string, env?: NodeJS.ProcessEnv) => string | null;
  systemPrompt?: string;
  /** Grace period after spawn before the first injection (default 1500ms). */
  readyDelayMs?: number;
  /** Idle debounce after the last fetch ends (default 500ms). */
  busyDebounceMs?: number;
  /** Passed through to `InjectionController` — delay between typing text and Enter (default 250ms). */
  submitDelayMs?: number;
  /** Passed through to `InjectionController` — post-submit quiet window (default 1200ms). */
  postSubmitCooldownMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: Logger;
}

export interface PtyClaudeSessionHandle {
  /** Resolves with the child's exit code once `claude` exits (or 1 on a spawn/setup failure). */
  readonly done: Promise<number>;
  /** Types a web-originated message into the live PTY when idle (queued while busy). */
  injectMessage(message: PendingInjection): void;
  /**
   * Feed the real provider session id (from the caller's single shared hook
   * server's `SessionStart`) to the transcript tailer. Buffered if the tailer
   * isn't up yet. Replaces the old self-owned hook server's direct
   * `scanner.onNewSession` call.
   */
  notifyProviderSessionId(id: string): void;
  /**
   * Reflects "a TUI dialog is open" from the hook layer (`Notification`
   * attention / a local-turn `PreToolUse`-or-`PermissionRequest` deferral) —
   * gates injection so a queued web message is never typed into an open
   * dialog (plan-v2.md W1.3).
   */
  setPromptOpen(open: boolean): void;
  /** Sends a single Escape into the PTY — the TUI's own cancel gesture (plan-v2.md W1.5). */
  sendInterrupt(): boolean;
  /** Terminates the session (SIGTERM to the pty child). Safe to call once. */
  stop(): void;
}

/**
 * Start one PTY-attached Claude session. Returns immediately with a handle;
 * spawn/setup happens asynchronously, and `injectMessage` calls made before
 * setup finishes are queued by the `InjectionController` until the TUI is
 * ready. See the module doc for the model.
 */
export function startPtyClaudeSession(
  opts: PtyClaudeSessionOptions,
  deps: PtyClaudeSessionDeps = {},
): PtyClaudeSessionHandle {
  const logger = deps.logger ?? opts.logger ?? noopLogger;
  const env = opts.env ?? process.env;
  const spawnPty = deps.spawnPty ?? ((file, args, options) => spawnPtyDefault(file, args, options));
  const stdin = deps.stdin ?? (process.stdin as unknown as StdinLike);
  const stdout = deps.stdout ?? (process.stdout as unknown as StdoutLike);
  const createSessionScanner = deps.createSessionScanner ?? createSessionScannerDefault;
  const createFetchSignalServer = deps.createFetchSignalServer ?? createFetchSignalServerDefault;
  const findLastSession = deps.findLastSession ?? findLastLocalSession;
  const systemPrompt = deps.systemPrompt ?? FALCON_SYSTEM_PROMPT;
  const readyDelayMs = deps.readyDelayMs ?? DEFAULT_READY_DELAY_MS;
  const busyDebounceMs = deps.busyDebounceMs ?? DEFAULT_BUSY_DEBOUNCE_MS;
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? ((handle) => clearTimeout(handle));

  let ptyProcess: PtyLike | null = null;
  let settled = false;
  let stopped = false;
  const cleanups: Array<() => void | Promise<void>> = [];

  // The transcript tailer, created asynchronously in `run()`. The provider
  // session id arrives from the caller's shared hook server via
  // `notifyProviderSessionId()` and is routed here; if it lands before the
  // tailer is up it's buffered and applied once the tailer exists.
  let scanner: SessionScanner | null = null;
  let bufferedSessionId: string | null = null;
  const routeProviderSessionId = (id: string): void => {
    if (scanner) void scanner.onNewSession(id);
    else bufferedSessionId = id;
  };

  const controller = new InjectionController({
    writeText: (text) => ptyProcess?.write(text),
    submit: () => ptyProcess?.write(SUBMIT_KEY),
    onInjected: (id) => opts.onInjected?.(id),
    submitDelayMs: deps.submitDelayMs,
    postSubmitCooldownMs: deps.postSubmitCooldownMs,
    setTimeoutImpl,
    clearTimeoutImpl,
    logger,
  });
  cleanups.push(() => controller.dispose());

  // Debounced busy edge from the launcher's fetch-start/fetch-end signal —
  // structurally identical to `claudeLocal.ts`'s "thinking" tracking.
  const activeFetches = new Set<number>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeoutImpl(idleTimer);
      idleTimer = null;
    }
  };
  cleanups.push(clearIdleTimer);
  const onFetchEvent = (event: FetchSignalEvent): void => {
    if (event.type === "fetch-start") {
      activeFetches.add(event.id);
      clearIdleTimer();
      controller.setBusy(true);
    } else {
      activeFetches.delete(event.id);
      if (activeFetches.size === 0 && !idleTimer) {
        idleTimer = setTimeoutImpl(() => {
          idleTimer = null;
          if (activeFetches.size === 0) controller.setBusy(false);
        }, busyDebounceMs);
      }
    }
  };

  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const teardown = async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        logger.debug("[pty-session] cleanup step failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    void teardown().finally(() => resolveDone(code));
  };

  async function run(): Promise<void> {
    try {
      // Transcript tailer → structured envelopes for the web timeline. This is
      // the mirroring path, unchanged from the legacy local launcher (minus the
      // cross-mode dedupe, which had no purpose without a second producer). The
      // provider session id that drives `onNewSession` comes from the caller's
      // single shared hook server via `notifyProviderSessionId()`, not a
      // hook server owned here.
      const mapperState = createClaudeEnvelopeMapperState();
      const sessionScanner: SessionScanner = await createSessionScanner({
        sessionId: opts.providerSessionId,
        workingDirectory: opts.workingDirectory,
        onMessage: (raw) => {
          const envelopes = mapClaudeToEnvelopes(raw, mapperState);
          if (envelopes.length > 0) opts.onEnvelopes(envelopes);
        },
        logger,
        env,
      });
      scanner = sessionScanner;
      cleanups.push(() => sessionScanner.cleanup());
      // A provider session id that arrived before the tailer was up is applied now.
      if (bufferedSessionId) {
        void sessionScanner.onNewSession(bufferedSessionId);
        bufferedSessionId = null;
      }

      // Unix-socket transport for the launcher's fetch-start/fetch-end signal
      // (no fd 3 under a PTY). Best-effort: on bind failure the idle edge is
      // simply never observed and injection falls back to the cooldown gate.
      const fetchSignal: FetchSignalServer = await createFetchSignalServer({
        homeDir: opts.homeDir,
        onEvent: onFetchEvent,
        logger,
      });
      cleanups.push(() => fetchSignal.close());

      // Resolve --resume/--continue/--session-id exactly like the legacy local
      // spawn, then build the hook-mode arg list.
      const { claudeArgs: resolvedArgs, startFrom } = resolveSessionFlags(
        {
          claudeArgs: opts.claudeArgs,
          sessionId: opts.providerSessionId,
          workingDirectory: opts.workingDirectory,
        },
        findLastSession,
        env,
        logger,
      );
      if (startFrom) {
        void sessionScanner.onNewSession(startFrom, { treatExistingAsProcessed: true });
      }

      const args: string[] = [];
      if (startFrom) args.push("--resume", startFrom);
      args.push("--append-system-prompt", systemPrompt);
      args.push(...resolvedArgs);
      // The single shared hook server's `--settings` file (SessionStart/
      // Notification/Stop/PreToolUse), owned by the caller's
      // `installRemotePermissionHook()` composition. Absent only when the hook
      // server failed to install (session then runs without hooks).
      if (opts.settingsPath) args.push("--settings", opts.settingsPath);

      const cols = stdout.columns ?? DEFAULT_COLS;
      const rows = stdout.rows ?? DEFAULT_ROWS;
      const spawnEnv: NodeJS.ProcessEnv = {
        ...env,
        ...(opts.settingsEnv ?? {}),
        FALCON_CLAUDE_PATH: opts.claudeCliPath,
      };
      if (fetchSignal.path) spawnEnv.FALCON_FETCH_SIGNAL_PATH = fetchSignal.path;

      logger.debug("[pty-session] spawning claude on PTY", {
        launcherPath: opts.launcherPath,
        args,
        cols,
        rows,
      });

      const child = spawnPty("node", [opts.launcherPath, ...args], {
        name: DEFAULT_PTY_NAME,
        cols,
        rows,
        cwd: opts.workingDirectory,
        env: spawnEnv,
      });
      ptyProcess = child;

      // PTY output → the real terminal.
      const dataSub = child.onData((data) => {
        stdout.write(data);
      });
      cleanups.push(() => dataSub.dispose());

      // The real terminal's stdin → the PTY, byte-for-byte in raw mode so the
      // TUI is fully interactive (typing, slash commands, Ctrl-C, etc.).
      if (stdin.isTTY && stdin.setRawMode) {
        try {
          stdin.setRawMode(true);
        } catch (error) {
          logger.debug("[pty-session] setRawMode(true) failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Local-typing signals for the injection gate (plan-v2.md W1.2/W1.3),
      // skipped entirely while a queued web message is itself mid-injection
      // (`controller.isInjecting`) — those synthetic keystrokes are not the
      // human at the keyboard.
      let draftIdleTimer: ReturnType<typeof setTimeout> | null = null;
      const onStdinData = (data: Buffer): void => {
        if (!controller.isInjecting) {
          if (data.includes(0x0d) || data.includes(0x0a) || data.includes(0x1b)) {
            // Enter / newline / Escape all end a draft-in-progress.
            controller.setLocalDraft(false);
            if (data.includes(0x0d) || data.includes(0x0a)) opts.onLocalSubmit?.();
          } else if (data.some((b) => b >= 0x20 || b === 0x08 || b === 0x7f)) {
            // A printable char (or backspace/DEL) means the human is composing
            // at the real prompt — hold injection until they submit, cancel,
            // or go quiet for DRAFT_IDLE_MS.
            controller.setLocalDraft(true);
            if (draftIdleTimer) clearTimeoutImpl(draftIdleTimer);
            draftIdleTimer = setTimeoutImpl(() => controller.setLocalDraft(false), DRAFT_IDLE_MS);
          }
        }
        ptyProcess?.write(data.toString("utf8"));
      };
      stdin.on("data", onStdinData);
      stdin.resume();
      cleanups.push(() => {
        stdin.removeListener("data", onStdinData);
        stdin.pause();
        if (stdin.isTTY && stdin.setRawMode) {
          try {
            stdin.setRawMode(false);
          } catch {
            // Best-effort restore only.
          }
        }
      });
      cleanups.push(() => {
        if (draftIdleTimer) clearTimeoutImpl(draftIdleTimer);
      });

      // Terminal resize → pty resize (Node emits 'resize' on stdout when the
      // controlling terminal changes size; the same event SIGWINCH drives).
      const onResize = (): void => {
        ptyProcess?.resize(stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS);
      };
      stdout.on("resize", onResize);
      cleanups.push(() => stdout.removeListener("resize", onResize));

      // Let the TUI paint its prompt before the first web message is typed in.
      const readyTimer = setTimeoutImpl(() => controller.markReady(), readyDelayMs);
      cleanups.push(() => clearTimeoutImpl(readyTimer));

      const exitSub = child.onExit(({ exitCode }) => {
        logger.debug("[pty-session] claude exited", { exitCode });
        finish(exitCode);
      });
      cleanups.push(() => exitSub.dispose());
    } catch (error) {
      logger.error("[pty-session] setup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      finish(1);
    }
  }

  void run();

  return {
    done,
    injectMessage: (message) => controller.enqueue(message),
    notifyProviderSessionId: (id) => routeProviderSessionId(id),
    setPromptOpen: (open) => controller.setPromptOpen(open),
    sendInterrupt: () => {
      if (!ptyProcess) return false;
      ptyProcess.write("\u001b"); // ESC, the TUI's own cancel gesture
      return true;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        ptyProcess?.kill();
      } catch (error) {
        logger.debug("[pty-session] kill failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
