
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import crossSpawn from "cross-spawn";
import type { Logger } from "../logger.js";
import { getProjectPath } from "./scanner.js";

/** Thrown when the spawned child exits with a non-zero, non-null exit code. */
export class ExitCodeError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`Process exited with code: ${exitCode}`);
    this.name = "ExitCodeError";
    this.exitCode = exitCode;
  }
}

/** Default system prompt Kvy appends via `--append-system-prompt`. */
export const KVY_SYSTEM_PROMPT =
  "You are running inside Kvy, a terminal + web session wrapper around Claude Code.";

const SESSION_ID_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort check that a session's transcript actually contains a real message entry. */
function hasValidSessionEntries(projectDir: string, sessionId: string): boolean {
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  if (!existsSync(sessionFile)) return false;

  let contents: string;
  try {
    contents = readFileSync(sessionFile, "utf-8");
  } catch {
    return false;
  }

  return contents.split("\n").some((line) => {
    if (!line.trim()) return false;
    try {
      const parsed = JSON.parse(line) as {
        uuid?: unknown;
        messageId?: unknown;
        leafUuid?: unknown;
      };
      return (
        (typeof parsed.uuid === "string" && parsed.uuid.length > 0) ||
        (typeof parsed.messageId === "string" && parsed.messageId.length > 0) ||
        (typeof parsed.leafUuid === "string" && parsed.leafUuid.length > 0)
      );
    } catch {
      return false;
    }
  });
}

/**
 * Find the most recently modified valid session transcript for a working
 * directory. A valid session has a UUID-shaped id (Claude Code 2.0.65+
 * requires this for `--resume`) and at least one real message entry.
 */
export function findLastLocalSession(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const projectDir = getProjectPath(workingDirectory, env);

  let files: string[];
  try {
    files = readdirSync(projectDir);
  } catch {
    return null; // No project directory yet — no sessions to resume.
  }

  const candidates = files
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const sessionId = file.slice(0, -".jsonl".length);
      if (!SESSION_ID_UUID_PATTERN.test(sessionId)) return null;
      if (!hasValidSessionEntries(projectDir, sessionId)) return null;
      try {
        return { sessionId, mtimeMs: statSync(join(projectDir, file)).mtimeMs };
      } catch {
        return null; // Vanished between readdir and stat — skip it.
      }
    })
    .filter((entry): entry is { sessionId: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.sessionId ?? null;
}

interface ExtractedFlag {
  found: boolean;
  value?: string;
}

/**
 * Remove the first occurrence of any of `flags` from `args` (mutating it in
 * place) and report whether/what was found. When `withValue` is true, a flag
 * is only extracted if immediately followed by a non-flag-looking value —
 * otherwise it's left untouched (`found: false`) so Claude Code's own
 * handling of e.g. a bare trailing `--resume` still applies.
 */
function extractFlag(args: string[], flags: string[], withValue: boolean): ExtractedFlag {
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index === -1) continue;

    if (withValue) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) return { found: false };
      args.splice(index, 2);
      return { found: true, value: next };
    }

    args.splice(index, 1);
    return { found: true };
  }
  return { found: false };
}

export interface ClaudeLocalOptions {
  /** Aborting this signal terminates the child with SIGTERM, treated as a clean exit. */
  abort: AbortSignal;
  /**
   * Kvy's currently known provider session id for this workspace (e.g.
   * carried over from a prior turn), or null to start fresh unless a
   * `--resume`/`--continue`/`--session-id` flag says otherwise.
   */
  sessionId: string | null;
  /** cwd for the spawned process; also where session transcripts are looked up. */
  workingDirectory: string;
  /**
   * Provider passthrough args (already stripped of any Kvy-only flags by
   * the caller's arg parser). Session flags are extracted from a local copy
   * — the array the caller passed in is never mutated.
   */
  claudeArgs?: string[];
  claudeEnvVars?: Record<string, string>;
  /**
   * Absolute path to a temp `--settings` file wiring the SessionStart hook
   * (`hookServer.ts`'s `writeHookSettingsFile`). Omit/null to run in
   * "offline" mode, where Kvy mints/tracks the session id itself instead
   * of waiting on the hook to report it.
   */
  hookSettingsPath?: string | null;
  /**
   * Called as soon as the effective session id is known. In offline mode
   * this fires synchronously before spawn; in hook mode it does not fire
   * here at all — the hook server's own callback reports it later.
   */
  onSessionFound: (id: string) => void;
  onThinkingChange?: (thinking: boolean) => void;
}

export interface ClaudeLocalDeps {
  /** Resolved path to `kvy_claude_launcher.cjs` — supplied by the caller. */
  launcherPath: string;
  /** Injectable for tests; defaults to `cross-spawn`'s `spawn`. */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Injectable for tests; defaults to `findLastLocalSession`. */
  findLastSession?: (workingDirectory: string, env?: NodeJS.ProcessEnv) => string | null;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  systemPrompt?: string;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** How long after the last active fetch ends before `thinking` flips back to false. */
const STOP_THINKING_DEBOUNCE_MS = 500;

interface StdinBlockingHandle {
  setBlocking?: (blocking: boolean) => void;
}

/**
 * Force blocking I/O on the inherited stdin fd. Node leaves O_NONBLOCK set
 * after libuv-mode reads; when the spawned child inherits the fd and tries to
 * read in blocking mode, EAGAIN comes back instead of bytes — the visible
 * symptom is duplicated cursors and garbled echo on macOS/Linux right after a
 * remote→local switch. Calling `setBlocking(true)` here clears O_NONBLOCK
 * before `cross-spawn` dups the fd into the child.
 */
function forceStdinBlocking(logger: Logger): void {
  const stdinHandle = (process.stdin as unknown as { _handle?: StdinBlockingHandle })._handle;
  if (!stdinHandle || typeof stdinHandle.setBlocking !== "function") return;
  try {
    stdinHandle.setBlocking(true);
    logger.debug("[claudeLocal] forced stdin to blocking mode before spawn");
  } catch (error) {
    logger.debug("[claudeLocal] setBlocking(true) failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resolve which Claude Code session (if any) to resume, and re-derive the
 * flags to pass Claude Code, from the raw passthrough args. Mutates a copy
 * of `claudeArgs`, never the caller's array.
 *
 * Exported so the PTY-injection session model (`ptyClaudeSession.ts`) reuses
 * the exact same `--resume`/`--continue`/`--session-id` resolution as the
 * legacy `stdio:'inherit'` local spawn — narrowed to the three fields it
 * actually reads so a caller need not synthesize a full `ClaudeLocalOptions`.
 */
export function resolveSessionFlags(
  opts: Pick<ClaudeLocalOptions, "claudeArgs" | "sessionId" | "workingDirectory">,
  findLastSession: (workingDirectory: string, env?: NodeJS.ProcessEnv) => string | null,
  env: NodeJS.ProcessEnv,
  logger: Logger,
): { claudeArgs: string[]; startFrom: string | null; explicitSessionId: string | null } {
  const claudeArgs = [...(opts.claudeArgs ?? [])];
  let startFrom: string | null = opts.sessionId;

  // 1. Explicit --session-id <uuid>: forces a new session under that id.
  const sessionIdFlag = extractFlag(claudeArgs, ["--session-id"], true);
  const explicitSessionId = sessionIdFlag.found ? (sessionIdFlag.value ?? null) : null;
  if (explicitSessionId) {
    startFrom = null;
    logger.debug("[claudeLocal] using explicit --session-id", { sessionId: explicitSessionId });
  }

  // 2. --resume [id] / -r [id]: resume a specific session, or the last one.
  if (!startFrom && !explicitSessionId) {
    const resumeFlag = extractFlag(claudeArgs, ["--resume", "-r"], true);
    if (resumeFlag.found) {
      if (resumeFlag.value) {
        startFrom = resumeFlag.value;
        logger.debug("[claudeLocal] resuming session from --resume", { sessionId: startFrom });
      } else {
        const lastSession = findLastSession(opts.workingDirectory, env);
        if (lastSession) {
          startFrom = lastSession;
          logger.debug("[claudeLocal] --resume: found last session", { sessionId: startFrom });
        }
      }
    }
  }

  // 3. --continue / -c: resume the last session in this working directory.
  if (!startFrom && !explicitSessionId) {
    const continueFlag = extractFlag(claudeArgs, ["--continue", "-c"], false);
    if (continueFlag.found) {
      const lastSession = findLastSession(opts.workingDirectory, env);
      if (lastSession) {
        startFrom = lastSession;
        logger.debug("[claudeLocal] --continue: found last session", { sessionId: startFrom });
      }
    }
  }

  return { claudeArgs, startFrom, explicitSessionId };
}

/**
 * Spawn a local-mode Claude Code child process via the Kvy launcher
 * script. Resolves once the child exits cleanly; rejects with
 * `ExitCodeError` (non-zero exit) or a signal error; resolves on `SIGTERM`
 * while `opts.abort.aborted` is true (the abort-triggered shutdown path).
 *
 * Returns the effective session id: the resumed/explicit id in offline mode
 * or when resuming, or `null` in hook mode for a fresh session (the hook
 * server reports the real id asynchronously via its own callback).
 */
export async function claudeLocal(
  opts: ClaudeLocalOptions,
  deps: ClaudeLocalDeps,
): Promise<string | null> {
  const logger = deps.logger ?? noopLogger;
  const env = deps.env ?? process.env;
  const spawnImpl = deps.spawnImpl ?? crossSpawn;
  const findLastSession = deps.findLastSession ?? findLastLocalSession;
  const systemPrompt = deps.systemPrompt ?? KVY_SYSTEM_PROMPT;

  const hasUserSessionControl =
    (opts.claudeArgs?.includes("--continue") ?? false) ||
    (opts.claudeArgs?.includes("--resume") ?? false);

  const { claudeArgs, startFrom, explicitSessionId } = resolveSessionFlags(
    opts,
    findLastSession,
    env,
    logger,
  );

  // Session id handling depends on whether a hook server is wired up:
  //  - with hookSettingsPath: Claude Code reports the real id via the
  //    SessionStart hook (normal mode) — this call never invokes
  //    onSessionFound itself.
  //  - without: Kvy mints/tracks the session id itself (offline mode).
  let newSessionId: string | null = null;
  let effectiveSessionId: string | null = startFrom;

  if (!opts.hookSettingsPath) {
    newSessionId = startFrom ? null : (explicitSessionId ?? randomUUID());
    effectiveSessionId = startFrom ?? newSessionId;

    if (startFrom) {
      logger.debug("[claudeLocal] resuming session (offline mode)", { sessionId: startFrom });
      opts.onSessionFound(startFrom);
    } else if (explicitSessionId) {
      logger.debug("[claudeLocal] using explicit session id (offline mode)", {
        sessionId: explicitSessionId,
      });
      opts.onSessionFound(explicitSessionId);
    } else if (newSessionId) {
      logger.debug("[claudeLocal] generated new session id (offline mode)", {
        sessionId: newSessionId,
      });
      opts.onSessionFound(newSessionId);
    }
  } else if (startFrom) {
    logger.debug("[claudeLocal] will resume existing session (hook mode)", {
      sessionId: startFrom,
    });
  } else if (hasUserSessionControl) {
    logger.debug("[claudeLocal] user requested resume/continue; session id pending hook");
  } else {
    logger.debug("[claudeLocal] fresh start; session id pending hook");
  }

  // Thinking state.
  let thinking = false;
  let stopThinkingTimeout: NodeJS.Timeout | null = null;
  const updateThinking = (next: boolean): void => {
    if (thinking === next) return;
    thinking = next;
    logger.debug("[claudeLocal] thinking state changed", { thinking });
    opts.onThinkingChange?.(thinking);
  };

  process.stdin.pause();
  forceStdinBlocking(logger);

  try {
    await new Promise<void>((resolvePromise, reject) => {
      const args: string[] = [];

      if (!opts.hookSettingsPath) {
        const hasResumeFlagLeft = claudeArgs.includes("--resume") || claudeArgs.includes("-r");
        if (startFrom) {
          args.push("--resume", startFrom);
        } else if (!hasResumeFlagLeft && newSessionId) {
          args.push("--session-id", newSessionId);
        }
        // Else: a bare --resume/-r remains in claudeArgs — let Claude Code
        // handle it (e.g. its own interactive resume picker).
      } else if (startFrom) {
        args.push("--resume", startFrom);
      }

      args.push("--append-system-prompt", systemPrompt);
      args.push(...claudeArgs);

      if (opts.hookSettingsPath) {
        args.push("--settings", opts.hookSettingsPath);
        logger.debug("[claudeLocal] using hook settings", { path: opts.hookSettingsPath });
      }

      const spawnEnv = { ...env, ...opts.claudeEnvVars };

      logger.debug("[claudeLocal] spawning launcher", { launcherPath: deps.launcherPath, args });

      const child = spawnImpl("node", [deps.launcherPath, ...args], {
        stdio: ["inherit", "inherit", "inherit", "pipe"],
        signal: opts.abort,
        cwd: opts.workingDirectory,
        env: spawnEnv,
        windowsHide: true,
      });

      // Read fd 3 for fetch-start/fetch-end JSON lines emitted by the
      // launcher, deriving a debounced "thinking" boolean from active fetches.
      const fd3 = child.stdio[3];
      if (fd3) {
        const rl = createInterface({ input: fd3 as NodeJS.ReadableStream, crlfDelay: Infinity });
        const activeFetches = new Set<number>();

        rl.on("line", (line) => {
          let message: { type?: string; id?: number };
          try {
            message = JSON.parse(line);
          } catch {
            logger.debug("[claudeLocal] non-JSON line from fd3", { line });
            return;
          }

          if (message.type === "fetch-start" && typeof message.id === "number") {
            activeFetches.add(message.id);
            if (stopThinkingTimeout) {
              clearTimeout(stopThinkingTimeout);
              stopThinkingTimeout = null;
            }
            updateThinking(true);
          } else if (message.type === "fetch-end" && typeof message.id === "number") {
            activeFetches.delete(message.id);
            if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
              stopThinkingTimeout = setTimeout(() => {
                if (activeFetches.size === 0) updateThinking(false);
                stopThinkingTimeout = null;
              }, STOP_THINKING_DEBOUNCE_MS);
            }
          } else if (message.type !== undefined) {
            logger.debug("[claudeLocal] unknown fd3 message type", { type: message.type });
          }
        });

        rl.on("error", (error) => {
          logger.warn("[claudeLocal] error reading fd3", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

        child.on("exit", () => {
          if (stopThinkingTimeout) clearTimeout(stopThinkingTimeout);
          updateThinking(false);
        });
      }

      // Guards against a spawn failure (e.g. ENOENT on the launcher/node
      // binary) leaving the promise unsettled forever: 'error' may fire
      // without a following 'exit' (or alongside one, depending on
      // platform/Node version), so only the first of the two settles the
      // promise.
      let settled = false;

      child.on("error", (error) => {
        logger.debug("[claudeLocal] child process error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (settled) return;
        // Node's `child_process.spawn({ signal })` kills the child AND emits
        // this 'error' (an AbortError, message "The operation was aborted")
        // the instant the signal fires — which races ahead of, and often
        // wins against, the 'exit' handler's own "SIGTERM + aborted -> clean
        // switch" path below (both are listening on the same `settled`
        // guard, first one wins). Left unhandled, every local->remote mode
        // switch rejected this promise with a generic AbortError that
        // propagated all the way to `main()` and crashed the whole `kvy
        // claude` process — an intentional abort must resolve the same way
        // the 'exit' handler's clean path does, not be treated as a real
        // spawn failure.
        const isAbortError =
          opts.abort.aborted &&
          error instanceof Error &&
          (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
        settled = true;
        if (isAbortError) {
          resolvePromise();
          return;
        }
        reject(error);
      });

      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        if (signal === "SIGTERM" && opts.abort.aborted) {
          resolvePromise();
        } else if (signal) {
          reject(new Error(`Process terminated with signal: ${signal}`));
        } else if (code !== 0 && code !== null) {
          reject(new ExitCodeError(code));
        } else {
          resolvePromise();
        }
      });
    });
  } finally {
    process.stdin.resume();
    if (stopThinkingTimeout) {
      clearTimeout(stopThinkingTimeout);
      stopThinkingTimeout = null;
    }
    updateThinking(false);
  }

  return effectiveSessionId;
}
