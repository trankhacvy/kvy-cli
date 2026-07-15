#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArgParseError, type FalconCommand, parseArgs } from "./args.js";
import {
  describeKillSummary,
  type KillTarget,
  killAll,
  killAllForce,
  killDaemon,
  killSessions,
} from "./daemon/kill.js";
import { createLogger } from "./logger.js";

// Scaffolding note (plan.md §16, "1.3 CLI skeleton + local mode"): this
// module wires up arg parsing + a stub dispatcher only. Daemon control,
// provider spawning, and network calls are later 1.3/1.5 work — every
// branch below is an honest placeholder, not a half-implementation.
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
  falcon daemon start|stop|status   Manage the background daemon
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

function run(command: FalconCommand): number | Promise<number> {
  switch (command.type) {
    case "help":
      process.stdout.write(HELP_TEXT);
      return 0;
    case "version":
      process.stdout.write(`falcon ${readVersion()}\n`);
      return 0;
    case "start":
      process.stdout.write(describeStart(command));
      return 0;
    case "auth":
      process.stdout.write(`falcon auth ${command.action}: not implemented yet\n`);
      return 0;
    case "daemon":
      process.stdout.write(`falcon daemon ${command.action}: not implemented yet\n`);
      return 0;
    case "kill":
      return runKill(command.target);
    case "sessions":
      process.stdout.write(`falcon sessions ${command.action}: not implemented yet\n`);
      return 0;
    case "resume":
      process.stdout.write(`falcon resume ${command.sessionId}: not implemented yet\n`);
      return 0;
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

// `run()` is synchronous for every subcommand except `kill` (process-scan
// based, so inherently async — see `runKill` above). `main()` stays
// synchronous-by-default so every existing subcommand (and its tests) is
// unaffected, only widening to `Promise<number>` for the one command that
// needs it; the bottom-of-file guard below handles both shapes.
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
