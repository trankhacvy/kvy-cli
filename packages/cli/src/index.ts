#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArgParseError, type FalconCommand, parseArgs } from "./args.js";
import { runAuthCommand } from "./auth/index.js";
import {
  createDaemonCommandDeps,
  runDaemonStart,
  runDaemonStartSync,
  runDaemonStatus,
  runDaemonStop,
} from "./daemon/commands.js";
import {
  createEnsureDaemonRunningDeps,
  ensureDaemonRunning,
} from "./daemon/ensureDaemonRunning.js";
import {
  describeKillSummary,
  type KillTarget,
  killAll,
  killAllForce,
  killDaemon,
  killSessions,
} from "./daemon/kill.js";
import { createLogger } from "./logger.js";

// Scaffolding note (plan.md §16, "1.3 CLI skeleton + local mode"): most of
// this module still wires up arg parsing + a stub dispatcher. `auth` is now
// a real implementation (`./auth/`, falcon-plan.md §2.2); daemon control is
// real too (`./daemon/`); provider spawning and the rest of the network
// calls are later 1.3/1.5 work — every other branch below is an honest
// placeholder, not a half-implementation.
//
// Help text, `--version`, and error messages are ordinary CLI output and go
// straight to stdout/stderr, same as any CLI. That's unrelated to the
// logger's "never stdout" rule (see logger.ts) — that rule is about
// internal diagnostics colliding with an *inherited* provider TUI once a
// session is actually spawned (§6.3), which doesn't happen here yet.

const logger = createLogger();

function readVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP_TEXT = `falcon — wrapper CLI for Claude Code / Codex agent sessions

Usage:
  falcon                            Start a session with the default provider
  falcon claude [args...]           Start a Claude Code session (flags pass through)
  falcon codex [args...]            Start a Codex session (flags pass through)
  falcon -b <branch>                Start a session on a new git worktree/branch
  falcon auth login|logout|status   Manage Falcon account auth
  falcon daemon start [--no-wait] | start-sync | stop | status
                                     Manage the background daemon
  falcon kill daemon|sessions|all|all-force
                                     Process management escape hatches
  falcon sessions list              List active/recent sessions on this machine
  falcon resume <session-id>        Reattach a terminal to an existing session
  falcon workspace config [--base-ref <ref>] [--remote <name>] [--directory <path>]
  falcon workspace sync             (coming soon)
  falcon notify -p <message>        Send a test push notification
  falcon --help, -h                 Show this help
  falcon --version, -v              Show the CLI version

Environment: FALCON_BACKEND_URL, FALCON_FRONTEND_URL, FALCON_HOME_DIR,
FALCON_DEBUG=1, FALCON_NO_UPDATE=1, FALCON_NO_SERVICE=1
`;

function describeStart(command: Extract<FalconCommand, { type: "start" }>): string {
  const parts = [`falcon: would start a ${command.provider} session`];
  if (command.branch !== undefined) parts.push(`on branch "${command.branch}"`);
  if (command.providerArgs.length > 0) parts.push(`with args: ${command.providerArgs.join(" ")}`);
  parts.push("(provider spawning not implemented yet)");
  return `${parts.join(" ")}\n`;
}

/**
 * Auto-starts the background daemon ahead of every agent-invoking
 * subcommand (plan.md §16 1.5, PRD FR-1.2: "First run of `falcon` triggers
 * ... daemon auto-start — no separate setup steps"). `FALCON_NO_SERVICE=1`
 * opts out entirely — `ensureDaemonRunning()`'s "disabled" result is
 * treated the same as success here, since the user has explicitly taken
 * over daemon lifecycle management themselves.
 */
async function ensureDaemon(): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await ensureDaemonRunning(
    createEnsureDaemonRunningDeps({ version: readVersion() }),
  );
  if (result.ok || result.reason === "disabled") return { ok: true };
  return { ok: false, message: result.message };
}

/**
 * `falcon kill *` is process-scan based (plan.md §7.2/§7.4) and therefore
 * inherently async (it shells out to `ps`, then waits out a graceful-stop
 * timeout) — the only subcommand so far that can't return its exit code
 * synchronously. See the `main()`/bottom-of-file guard for how that's
 * reconciled with every other subcommand staying synchronous.
 */
async function runKill(target: KillTarget): Promise<number> {
  const summary = await (target === "daemon"
    ? killDaemon()
    : target === "sessions"
      ? killSessions()
      : target === "all"
        ? killAll()
        : killAllForce());
  process.stdout.write(describeKillSummary(target, summary));
  const hasFailures = summary.outcomes.some((o) => o.error !== undefined);
  return hasFailures ? 1 : 0;
}

/**
 * `falcon daemon start|start-sync|stop|status` (plan.md §7.2, design §8) —
 * wires the singleton lock + control server + `daemon.state.json` helpers
 * together; see `daemon/commands.ts` for the actual logic. `start-sync` is
 * the one branch that can block indefinitely (it's the daemon's own
 * long-running process body), same as `kill`'s async-by-necessity shape.
 */
async function runDaemon(command: Extract<FalconCommand, { type: "daemon" }>): Promise<number> {
  // Pass this process's own version through explicitly rather than relying on
  // daemon/commands.ts's default (which locates package.json relative to its
  // own source file — correct in dev via `tsx`, but not once pkgroll bundles
  // every module into a single `dist/index.mjs` and that relative path no
  // longer lines up). `readVersion()` above is already bundle-path-correct
  // since `--version` depends on it working in both modes.
  const deps = createDaemonCommandDeps({ version: readVersion() });
  switch (command.action) {
    case "start": {
      const { code, message } = await runDaemonStart(deps, { noWait: command.noWait });
      process.stdout.write(message);
      return code;
    }
    case "start-sync":
      return runDaemonStartSync(deps);
    case "stop": {
      const { code, message } = await runDaemonStop(deps);
      process.stdout.write(message);
      return code;
    }
    case "status": {
      const { code, message } = await runDaemonStatus(deps);
      process.stdout.write(message);
      return code;
    }
  }
}

/**
 * `falcon` / `falcon claude` / `falcon codex` — the primary agent-invoking
 * entrypoint. Provider spawning itself is still a stub (see
 * `describeStart`), but the daemon auto-start it depends on (PRD FR-1.2)
 * is real: this is the first place a fresh install actually touches the
 * daemon.
 */
async function runStart(command: Extract<FalconCommand, { type: "start" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  process.stdout.write(describeStart(command));
  return 0;
}

/**
 * `falcon auth login|logout|status` (plan.md §5, design §5) — the real
 * OAuth browser flow + pairing fallback lives in `./auth/`. `ensureDaemon()`
 * runs first for consistency with every other agent-adjacent subcommand
 * (PRD FR-1.2) — a fresh install's very first command is commonly `falcon
 * auth login`, and that should still trigger the daemon auto-start — even
 * though the auth flow itself talks to the backend/browser directly and
 * doesn't otherwise depend on the daemon being up.
 */
async function runAuth(command: Extract<FalconCommand, { type: "auth" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  return runAuthCommand(command.action, logger);
}

async function runSessions(command: Extract<FalconCommand, { type: "sessions" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  process.stdout.write(`falcon sessions ${command.action}: not implemented yet\n`);
  return 0;
}

async function runResume(command: Extract<FalconCommand, { type: "resume" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  process.stdout.write(`falcon resume ${command.sessionId}: not implemented yet\n`);
  return 0;
}

function run(command: FalconCommand): number | Promise<number> {
  switch (command.type) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return 0;
    case "version":
      process.stdout.write(`falcon ${readVersion()}\n`);
      return 0;
    case "start":
      return runStart(command);
    case "auth":
      return runAuth(command);
    case "daemon":
      return runDaemon(command);
    case "kill":
      return runKill(command.target);
    case "sessions":
      return runSessions(command);
    case "resume":
      return runResume(command);
    case "workspace-config":
      process.stdout.write("falcon workspace config: not implemented yet\n");
      return 0;
    case "workspace-sync":
      process.stdout.write("cloud sync coming soon\n");
      return 0;
    case "notify":
      process.stdout.write(`falcon notify "${command.message}": not implemented yet\n`);
      return 0;
  }
}

function handleUnexpectedError(error: unknown): number {
  if (error instanceof ArgParseError) {
    logger.warn("arg parse error", { message: error.message });
    process.stderr.write(`falcon: ${error.message}\n`);
    if (error.usage) process.stderr.write(`usage: ${error.usage}\n`);
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.error("unhandled error", { message });
  process.stderr.write("falcon: unexpected error — see ~/.falcon/logs for details\n");
  return 1;
}

// `run()` returns a `Promise<number>` for every subcommand that touches the
// daemon — `kill` (process-scan based, §7.2/§7.4) and `start`/`auth`/
// `sessions`/`resume` (all call `ensureDaemon()` first, PRD FR-1.2) — and a
// plain `number` for the handful that don't (`help`/`version`/`daemon`'s own
// subcommands notwithstanding, since `daemon` is itself always async).
// `main()`'s return type stays `number | Promise<number>` to cover both
// shapes; the bottom-of-file guard below handles either.
export function main(argv: string[] = process.argv.slice(2)): number | Promise<number> {
  logger.debug("cli invoked", { argv });
  try {
    const command = parseArgs(argv);
    logger.debug("parsed command", { command });
    const result = run(command);
    return result instanceof Promise ? result.catch(handleUnexpectedError) : result;
  } catch (error) {
    return handleUnexpectedError(error);
  }
}

// Guard so `main()` can be imported and unit-tested (src/index.test.ts)
// without also running the CLI as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = main();
  if (result instanceof Promise) {
    result.then((code) => process.exit(code));
  } else {
    process.exit(result);
  }
}
