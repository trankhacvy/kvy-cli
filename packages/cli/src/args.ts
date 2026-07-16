/**
 * Hand-rolled argument parsing for the `falcon` command surface (PRD §5.3,
 * plan.md §6.1). No CLI-parsing framework — same approach Happy uses, and
 * the one that makes verbatim flag passthrough easy to reason about: a
 * framework wants to own and validate every flag, which is exactly wrong
 * for `falcon claude [args...]`, where *every* flag must reach the
 * underlying provider CLI untouched.
 *
 * Two parsing modes coexist:
 *  - Falcon's own subcommands (`auth`, `daemon`, `kill`, `doctor`,
 *    `sessions`, `resume`, `workspace`, `notify`, `--help`, `--version`) are
 *    parsed and validated below.
 *  - `falcon claude [args...]` / `falcon codex [args...]` — and the
 *    default `falcon [args...]` form — never inspect `args`; they are
 *    forwarded verbatim as `providerArgs`.
 */

export type Provider = "claude" | "codex";

export type FalconCommand =
  | { type: "help" }
  | { type: "version" }
  | { type: "start"; provider: Provider; providerArgs: string[]; branch?: string }
  | { type: "auth"; action: "login" | "logout" | "status" }
  | { type: "daemon"; action: "start" | "start-sync" | "stop" | "status"; noWait: boolean }
  | { type: "kill"; target: "daemon" | "sessions" | "all" | "all-force" }
  | { type: "doctor"; action: "report" | "clean" }
  | { type: "sessions"; action: "list" }
  | { type: "resume"; sessionId: string }
  | { type: "workspace-config"; baseRef?: string; remote?: string; directory?: string }
  | { type: "workspace-sync" }
  | { type: "notify"; message: string };

/** Thrown for malformed Falcon-level commands. Never thrown for provider passthrough. */
export class ArgParseError extends Error {
  readonly usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = "ArgParseError";
    this.usage = usage;
  }
}

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v", "-V"]);
const PROVIDERS = new Set<Provider>(["claude", "codex"]);
const KILL_TARGETS = new Set(["daemon", "sessions", "all", "all-force"]);

export function parseArgs(argv: string[]): FalconCommand {
  if (argv.length === 0) return { type: "start", provider: "claude", providerArgs: [] };

  const first = argv[0] as string;
  const rest = argv.slice(1);

  // Top-level --help/--version always win, same as most CLIs. This only
  // applies to `falcon --help`, not `falcon claude --help` — the provider
  // check below runs first for a recognized provider name, so
  // `falcon claude --help` correctly forwards `--help` to Claude Code.
  if (HELP_FLAGS.has(first)) return { type: "help" };
  if (VERSION_FLAGS.has(first)) return { type: "version" };

  if (isProvider(first)) {
    // Everything after the provider name is passed through VERBATIM —
    // Falcon never interprets provider flags (PRD §5.3: "all unknown flags
    // pass through verbatim to the underlying CLI").
    return { type: "start", provider: first, providerArgs: rest };
  }

  switch (first) {
    case "auth":
      return parseAuth(rest);
    case "daemon":
      return parseDaemon(rest);
    case "kill":
      return parseKill(rest);
    case "doctor":
      return parseDoctor(rest);
    case "sessions":
      return parseSessions(rest);
    case "resume":
      return parseResume(rest);
    case "workspace":
      return parseWorkspace(rest);
    case "notify":
      return parseNotify(rest);
    default:
      // Not a known Falcon subcommand: the whole argv is passthrough to the
      // default provider (claude), same as `falcon claude [args...]` minus
      // the explicit provider name. This is what makes `falcon --resume <id>`
      // and `falcon -b feature/x` both work directly off `falcon`.
      return parseDefaultStart(argv);
  }
}

function isProvider(value: string): value is Provider {
  return PROVIDERS.has(value as Provider);
}

function parseDefaultStart(argv: string[]): FalconCommand {
  const providerArgs: string[] = [];
  let branch: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-b" || arg === "--branch") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ArgParseError(`${arg} requires a branch name`, "falcon -b <branch>");
      }
      branch = value;
      i++;
      continue;
    }
    providerArgs.push(arg);
  }

  return {
    type: "start",
    provider: "claude",
    providerArgs,
    ...(branch !== undefined ? { branch } : {}),
  };
}

function parseAuth(rest: string[]): FalconCommand {
  const action = rest[0];
  if (action === "login" || action === "logout" || action === "status") {
    return { type: "auth", action };
  }
  throw new ArgParseError(
    `Unknown "falcon auth" action: ${action ?? "(none)"}`,
    "falcon auth login|logout|status",
  );
}

function parseDaemon(rest: string[]): FalconCommand {
  const action = rest[0];
  if (action === "start") {
    return { type: "daemon", action: "start", noWait: rest.slice(1).includes("--no-wait") };
  }
  // `start-sync` is the daemon's own long-running process body (see
  // daemon/commands.ts) — normally spawned detached by `start` itself, but
  // also directly invocable (e.g. to run the daemon attached to a terminal
  // for debugging).
  if (action === "start-sync" || action === "stop" || action === "status") {
    return { type: "daemon", action, noWait: false };
  }
  throw new ArgParseError(
    `Unknown "falcon daemon" action: ${action ?? "(none)"}`,
    "falcon daemon start [--no-wait] | start-sync | stop | status",
  );
}

function parseKill(rest: string[]): FalconCommand {
  const target = rest[0];
  if (target !== undefined && KILL_TARGETS.has(target)) {
    return { type: "kill", target: target as "daemon" | "sessions" | "all" | "all-force" };
  }
  throw new ArgParseError(
    `Unknown "falcon kill" target: ${target ?? "(none)"}`,
    "falcon kill daemon|sessions|all|all-force",
  );
}

function parseDoctor(rest: string[]): FalconCommand {
  if (rest.length === 0) return { type: "doctor", action: "report" };
  if (rest[0] === "clean") return { type: "doctor", action: "clean" };
  throw new ArgParseError(`Unknown "falcon doctor" action: ${rest[0]}`, "falcon doctor [clean]");
}

function parseSessions(rest: string[]): FalconCommand {
  if (rest[0] === "list") return { type: "sessions", action: "list" };
  throw new ArgParseError(
    `Unknown "falcon sessions" action: ${rest[0] ?? "(none)"}`,
    "falcon sessions list",
  );
}

function parseResume(rest: string[]): FalconCommand {
  const sessionId = rest[0];
  if (!sessionId) {
    throw new ArgParseError('"falcon resume" requires a session id', "falcon resume <session-id>");
  }
  return { type: "resume", sessionId };
}

function parseWorkspace(rest: string[]): FalconCommand {
  const [action, ...opts] = rest;
  if (action === "sync") return { type: "workspace-sync" };
  if (action === "config") return parseWorkspaceConfig(opts);
  throw new ArgParseError(
    `Unknown "falcon workspace" action: ${action ?? "(none)"}`,
    "falcon workspace config|sync",
  );
}

const WORKSPACE_CONFIG_USAGE =
  "falcon workspace config [--base-ref <ref>] [--remote <name>] [--directory <path>]";

function parseWorkspaceConfig(opts: string[]): FalconCommand {
  const result: { baseRef?: string; remote?: string; directory?: string } = {};

  for (let i = 0; i < opts.length; i++) {
    const flag = opts[i] as string;
    const value = requireValue(flag, opts[i + 1], WORKSPACE_CONFIG_USAGE);
    i++;
    if (flag === "--base-ref") result.baseRef = value;
    else if (flag === "--remote") result.remote = value;
    else if (flag === "--directory") result.directory = value;
    else
      throw new ArgParseError(
        `Unknown "falcon workspace config" flag: ${flag}`,
        WORKSPACE_CONFIG_USAGE,
      );
  }

  return { type: "workspace-config", ...result };
}

function parseNotify(rest: string[]): FalconCommand {
  const flagIndex = rest.indexOf("-p");
  const message = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
  if (!message) {
    throw new ArgParseError('"falcon notify" requires -p <message>', "falcon notify -p <message>");
  }
  return { type: "notify", message };
}

function requireValue(flag: string, value: string | undefined, usage: string): string {
  if (value === undefined) throw new ArgParseError(`${flag} requires a value`, usage);
  return value;
}
