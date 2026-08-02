/**
 * No CLI-parsing framework — a framework wants to own and validate every
 * flag, which is exactly wrong when every flag must reach the underlying
 * provider CLI untouched.
 *
 * Two parsing modes coexist:
 *  - Kvy's own subcommands (`auth`, `daemon`, `kill`, `doctor`,
 *    `sessions`, `resume`, `workspace`, `notify`, `--help`,
 *    `--version`) are parsed and validated below.
 *  - `kvy claude [args...]` / `kvy codex [args...]` — and the
 *    default `kvy [args...]` form — never inspect `args`; they are
 *    forwarded verbatim as `providerArgs`.
 */

import { PROVIDER_REGISTRY } from "./provider/registry.js";

export type Provider = string;

export type KvyCommand =
  | { type: "help" }
  | { type: "version" }
  | { type: "start"; provider: Provider; providerArgs: string[]; branch?: string }
  | { type: "auth"; action: "login" | "logout" | "status" }
  | { type: "daemon"; action: "start" | "start-sync" | "stop" | "status"; noWait: boolean }
  | { type: "daemon-service"; action: "install" | "uninstall" | "status" }
  | { type: "kill"; target: "daemon" | "sessions" | "all" | "all-force" }
  | { type: "doctor"; action: "report" | "clean" }
  | { type: "sessions"; action: "list" }
  | { type: "resume"; sessionId: string }
  | {
      type: "workspace-config";
      baseRef?: string;
      remote?: string;
      setupScript?: string;
      runScript?: string;
      directory?: string;
    }
  | { type: "workspace-register"; directory?: string; name?: string }
  | { type: "workspace-list" }
  | { type: "workspace-unregister"; directory?: string }
  | { type: "workspace-sync" }
  | { type: "notify"; message: string }
  | { type: "adopt"; list: boolean; remote: boolean }
  | { type: "keys"; action: "approve" }
  | { type: "adapters"; action: "install" | "upgrade" }
  | { type: "github"; action: "login" | "logout" | "status"; token: boolean; clientId?: string }
  | { type: "update" };

/** Thrown for malformed Kvy-level commands. Never thrown for provider passthrough. */
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
const CONTINUE_FLAGS = new Set(["--continue"]);
const PROVIDERS = new Set<Provider>(
  Object.values(PROVIDER_REGISTRY).map((entry) => entry.kvySubcommand),
);
const KILL_TARGETS = new Set(["daemon", "sessions", "all", "all-force"]);

export function parseArgs(argv: string[]): KvyCommand {
  // `pnpm --filter <pkg> dev -- <args...>` (CLAUDE.md's documented dev
  // invocation style) forwards a literal leading "--" token into the
  // script's own argv — unlike `npm run <script> -- <args...>`, which strips
  // it. Left unhandled, that stray "--" isn't a recognized provider name or
  // Kvy subcommand, so it fell through to `parseDefaultStart`, which
  // forwards the *entire* original argv (including "auth"/"status"/etc. as
  // literal words) to `claude` as passthrough args — silently misrouting
  // `pnpm --filter @vibe-oss/kvy dev -- auth login` into starting a claude session
  // instead of running the intended `auth login` subcommand. Stripping a
  // single leading "--" here (once, not repeatedly — a real provider
  // passthrough could legitimately want its own "--") makes `pnpm --filter
  // kvy dev -- <args...>` behave identically to invoking the CLI
  // directly, for every subcommand, not just `claude`/`codex`.
  const withoutPnpmSeparator = argv[0] === "--" ? argv.slice(1) : argv;

  if (withoutPnpmSeparator.length === 0) {
    return { type: "start", provider: "claude", providerArgs: [] };
  }

  const first = withoutPnpmSeparator[0] as string;
  const rest = withoutPnpmSeparator.slice(1);

  // Top-level --help/--version always win, same as most CLIs. This only
  // applies to `kvy --help`, not `kvy claude --help` — the provider
  // check below runs first for a recognized provider name, so
  // `kvy claude --help` correctly forwards `--help` to Claude Code.
  if (HELP_FLAGS.has(first)) return { type: "help" };
  if (VERSION_FLAGS.has(first)) return { type: "version" };
  // `kvy --continue` aliases `kvy adopt`: preselects the most-recent plain
  // session in cwd's workspace and continues it. `--remote`/`--list`
  // compose the same way as `kvy adopt` (`kvy --continue --remote`).
  if (CONTINUE_FLAGS.has(first)) return parseAdopt(rest);

  if (isProvider(first)) {
    // Everything after the provider name is passed through verbatim —
    // Kvy never interprets provider flags.
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
    case "adopt":
      return parseAdopt(rest);
    case "keys":
      return parseKeys(rest);
    case "adapters":
      return parseAdapters(rest);
    case "github":
      return parseGithub(rest);
    case "update":
      return { type: "update" };
    default:
      // Not a known Kvy subcommand: the whole argv is passthrough to the
      // default provider (claude), same as `kvy claude [args...]` minus
      // the explicit provider name. This is what makes `kvy --resume <id>`
      // and `kvy -b feature/x` both work directly off `kvy`. Uses
      // `withoutPnpmSeparator`, not the original `argv` — the stray leading
      // "--" (see above) must stay stripped here too, or it would leak into
      // `providerArgs` and get forwarded to claude/codex as a literal word.
      return parseDefaultStart(withoutPnpmSeparator);
  }
}

function isProvider(value: string): value is Provider {
  return PROVIDERS.has(value as Provider);
}

function parseDefaultStart(argv: string[]): KvyCommand {
  const providerArgs: string[] = [];
  let branch: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-b" || arg === "--branch") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ArgParseError(`${arg} requires a branch name`, "kvy -b <branch>");
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

function parseAuth(rest: string[]): KvyCommand {
  const action = rest[0];
  if (action === "login" || action === "logout" || action === "status") {
    return { type: "auth", action };
  }
  throw new ArgParseError(
    `Unknown "kvy auth" action: ${action ?? "(none)"}`,
    "kvy auth login|logout|status",
  );
}

function parseDaemon(rest: string[]): KvyCommand {
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
  // `kvy daemon service` is its own command type rather than overloading
  // `daemon`'s `status`/`start` actions — "is the OS service registered"
  // is a distinct question from "is the daemon process currently running".
  if (action === "service") {
    return parseDaemonService(rest.slice(1));
  }
  throw new ArgParseError(
    `Unknown "kvy daemon" action: ${action ?? "(none)"}`,
    "kvy daemon start [--no-wait] | start-sync | stop | status | service install|uninstall|status",
  );
}

function parseDaemonService(rest: string[]): KvyCommand {
  const action = rest[0];
  if (action === "install" || action === "uninstall" || action === "status") {
    return { type: "daemon-service", action };
  }
  throw new ArgParseError(
    `Unknown "kvy daemon service" action: ${action ?? "(none)"}`,
    "kvy daemon service install|uninstall|status",
  );
}

function parseKill(rest: string[]): KvyCommand {
  const target = rest[0];
  if (target !== undefined && KILL_TARGETS.has(target)) {
    return { type: "kill", target: target as "daemon" | "sessions" | "all" | "all-force" };
  }
  throw new ArgParseError(
    `Unknown "kvy kill" target: ${target ?? "(none)"}`,
    "kvy kill daemon|sessions|all|all-force",
  );
}

function parseDoctor(rest: string[]): KvyCommand {
  if (rest.length === 0) return { type: "doctor", action: "report" };
  if (rest[0] === "clean") return { type: "doctor", action: "clean" };
  throw new ArgParseError(`Unknown "kvy doctor" action: ${rest[0]}`, "kvy doctor [clean]");
}

function parseSessions(rest: string[]): KvyCommand {
  if (rest[0] === "list") return { type: "sessions", action: "list" };
  throw new ArgParseError(
    `Unknown "kvy sessions" action: ${rest[0] ?? "(none)"}`,
    "kvy sessions list",
  );
}

function parseResume(rest: string[]): KvyCommand {
  const sessionId = rest[0];
  if (!sessionId) {
    throw new ArgParseError('"kvy resume" requires a session id', "kvy resume <session-id>");
  }
  return { type: "resume", sessionId };
}

function parseWorkspace(rest: string[]): KvyCommand {
  const [action, ...opts] = rest;
  if (action === "sync") return { type: "workspace-sync" };
  if (action === "config") return parseWorkspaceConfig(opts);
  if (action === "register") return parseWorkspaceRegister(opts);
  if (action === "list") return { type: "workspace-list" };
  if (action === "unregister") return parseWorkspaceUnregister(opts);
  throw new ArgParseError(
    `Unknown "kvy workspace" action: ${action ?? "(none)"}`,
    "kvy workspace config|register|list|unregister|sync",
  );
}

const WORKSPACE_CONFIG_USAGE =
  "kvy workspace config [--base-ref <ref>] [--remote <name>] [--setup-script <script>] [--run-script <script>] [--directory <path>]";

function parseWorkspaceConfig(opts: string[]): KvyCommand {
  const result: {
    baseRef?: string;
    remote?: string;
    setupScript?: string;
    runScript?: string;
    directory?: string;
  } = {};

  for (let i = 0; i < opts.length; i++) {
    const flag = opts[i] as string;
    const value = requireValue(flag, opts[i + 1], WORKSPACE_CONFIG_USAGE);
    i++;
    if (flag === "--base-ref") result.baseRef = value;
    else if (flag === "--remote") result.remote = value;
    else if (flag === "--setup-script") result.setupScript = value;
    else if (flag === "--run-script") result.runScript = value;
    else if (flag === "--directory") result.directory = value;
    else
      throw new ArgParseError(
        `Unknown "kvy workspace config" flag: ${flag}`,
        WORKSPACE_CONFIG_USAGE,
      );
  }

  return { type: "workspace-config", ...result };
}

const WORKSPACE_REGISTER_USAGE =
  "kvy workspace register [--directory <path>] [--name <display-name>]";

function parseWorkspaceRegister(opts: string[]): KvyCommand {
  const result: { directory?: string; name?: string } = {};

  for (let i = 0; i < opts.length; i++) {
    const flag = opts[i] as string;
    const value = requireValue(flag, opts[i + 1], WORKSPACE_REGISTER_USAGE);
    i++;
    if (flag === "--directory") result.directory = value;
    else if (flag === "--name") result.name = value;
    else
      throw new ArgParseError(
        `Unknown "kvy workspace register" flag: ${flag}`,
        WORKSPACE_REGISTER_USAGE,
      );
  }

  return { type: "workspace-register", ...result };
}

const WORKSPACE_UNREGISTER_USAGE = "kvy workspace unregister [--directory <path>]";

function parseWorkspaceUnregister(opts: string[]): KvyCommand {
  const result: { directory?: string } = {};

  for (let i = 0; i < opts.length; i++) {
    const flag = opts[i] as string;
    const value = requireValue(flag, opts[i + 1], WORKSPACE_UNREGISTER_USAGE);
    i++;
    if (flag === "--directory") result.directory = value;
    else
      throw new ArgParseError(
        `Unknown "kvy workspace unregister" flag: ${flag}`,
        WORKSPACE_UNREGISTER_USAGE,
      );
  }

  return { type: "workspace-unregister", ...result };
}

function parseNotify(rest: string[]): KvyCommand {
  const flagIndex = rest.indexOf("-p");
  const message = flagIndex >= 0 ? rest[flagIndex + 1] : undefined;
  if (!message) {
    throw new ArgParseError('"kvy notify" requires -p <message>', "kvy notify -p <message>");
  }
  return { type: "notify", message };
}

const ADOPT_USAGE = "kvy adopt [--remote] [--list]";

function parseAdopt(rest: string[]): KvyCommand {
  let list = false;
  let remote = false;
  for (const arg of rest) {
    if (arg === "--list") list = true;
    else if (arg === "--remote") remote = true;
    else throw new ArgParseError(`Unknown "kvy adopt" flag: ${arg}`, ADOPT_USAGE);
  }
  return { type: "adopt", list, remote };
}

/** Answer another device's key-sharing request. */
function parseKeys(rest: string[]): KvyCommand {
  const action = rest[0];
  if (action === "approve") return { type: "keys", action };
  throw new ArgParseError(`Unknown "kvy keys" action: ${action ?? "(none)"}`, "kvy keys approve");
}

function parseAdapters(rest: string[]): KvyCommand {
  const action = rest[0];
  if (action === "install" || action === "upgrade") {
    return { type: "adapters", action };
  }
  throw new ArgParseError(
    `Unknown "kvy adapters" action: ${action ?? "(none)"}`,
    "kvy adapters install|upgrade",
  );
}

const GITHUB_USAGE = "kvy github login [--token] [--client-id <id>] | logout | status";

/** `login`'s `--token` is a bare toggle, never a flag a token value can be passed to directly — that would leak into shell history and `ps` output. */
function parseGithub(rest: string[]): KvyCommand {
  const [action, ...opts] = rest;
  if (action === "logout" || action === "status") {
    return { type: "github", action, token: false };
  }
  if (action === "login") {
    let token = false;
    let clientId: string | undefined;
    for (let i = 0; i < opts.length; i++) {
      const flag = opts[i] as string;
      if (flag === "--token") {
        token = true;
        continue;
      }
      if (flag === "--client-id") {
        clientId = requireValue(flag, opts[i + 1], GITHUB_USAGE);
        i++;
        continue;
      }
      throw new ArgParseError(`Unknown "kvy github login" flag: ${flag}`, GITHUB_USAGE);
    }
    return {
      type: "github",
      action: "login",
      token,
      ...(clientId !== undefined ? { clientId } : {}),
    };
  }
  throw new ArgParseError(`Unknown "kvy github" action: ${action ?? "(none)"}`, GITHUB_USAGE);
}

function requireValue(flag: string, value: string | undefined, usage: string): string {
  if (value === undefined) throw new ArgParseError(`${flag} requires a value`, usage);
  return value;
}
