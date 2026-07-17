#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArgParseError, type FalconCommand, parseArgs } from "./args.js";
import { runAuthCommand } from "./auth/index.js";
import { CODEX_NO_LOCAL_MODE_NOTE } from "./codex/index.js";
import { createAdoptCommandDeps, runAdoptCommand } from "./commands/adopt.js";
import { runResumeCommand } from "./commands/resume.js";
import { runSessionsListCommand } from "./commands/sessionsList.js";
import { runShimCommand } from "./commands/shim.js";
import { runWorkspaceConfigCommand } from "./commands/workspaceConfig.js";
import {
  runWorkspaceListCommand,
  runWorkspaceRegisterCommand,
  runWorkspaceUnregisterCommand,
} from "./commands/workspaceRegister.js";
import {
  createDaemonCommandDeps,
  runDaemonStart,
  runDaemonStartSync,
  runDaemonStatus,
  runDaemonStop,
} from "./daemon/commands.js";
import {
  createDoctorDeps,
  describeDoctorCleanSummary,
  describeDoctorReport,
  runDoctor,
  runDoctorClean,
} from "./daemon/doctor.js";
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
import { resolveHomeDir } from "./home.js";
import { createLogger } from "./logger.js";
import { maybePromptShimOptIn } from "./shim/onboardingPrompt.js";

// Scaffolding note (plan.md §16, "1.3 CLI skeleton + local mode"): most of
// this module still wires up arg parsing + a stub dispatcher. `auth` is now
// a real implementation (`./auth/`, falcon-plan.md §2.2); daemon control is
// real too (`./daemon/`); `workspace-config` is real too (`./commands/
// workspaceConfig.js`, plan.md §16 "4.1 Git panel"); `workspace-sync` is a
// deliberate, permanent stub (falcon-prd.md line 149: "cloud sync coming
// soon" — sandboxing is out of scope); provider spawning and the rest of
// the network calls are later work — every other branch below is an honest
// placeholder, not a half-implementation.
//
// Help text, `--version`, and error messages are ordinary CLI output and go
// straight to stdout/stderr, same as any CLI. That's unrelated to the
// logger's "never stdout" rule (see logger.ts) — that rule is about
// internal diagnostics colliding with an *inherited* provider TUI once a
// session is actually spawned (§6.3), which doesn't happen here yet.

const logger = createLogger();

/** One level below the package root in both dev (`src/index.ts`) and prod (`dist/index.mjs`, pkgroll's single-file bundle) — this is why `path.join(dirname(entry), "..", ...)` resolves correctly either way, unlike a nested module's own `import.meta.url` (see `daemon/commands.ts`'s `readCliVersion()`/`defaultBundlePath()` doc comments). */
function packageRootDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function readVersion(): string {
  const pkgPath = path.join(packageRootDir(), "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The built CLI bundle's own path — `daemon/commands.ts`'s self-update
 * heartbeat (`selfUpdate.ts`) watches this file's mtime to detect an
 * `npm i -g falcon` (or similar) replacing the installed CLI on disk.
 * Passed explicitly (mirroring `version` above) since `commands.ts`'s own
 * default computation is only dev-correct, not bundle-correct.
 */
function resolveBundlePath(): string {
  return path.join(packageRootDir(), "dist", "index.mjs");
}

const HELP_TEXT = `falcon — wrapper CLI for Claude Code / Codex agent sessions

Usage:
  falcon                            Start a session with the default provider
  falcon claude [args...]           Start a Claude Code session (flags pass through)
  falcon codex [args...]            Start a Codex session (beta, no local TUI — flags pass through)
  falcon -b <branch>                Start a session on a new git worktree/branch
  falcon auth login|logout|status   Manage Falcon account auth
  falcon daemon start [--no-wait] | start-sync | stop | status
                                     Manage the background daemon
  falcon kill daemon|sessions|all|all-force
                                     Process management escape hatches
  falcon doctor [clean]              Discover/categorize Falcon processes (clean: kill runaways)
  falcon sessions list              List sessions (local, and this account's remote/other-machine)
  falcon resume <session-id>        Reattach a terminal to an existing local or daemon-managed session
  falcon adopt [--remote] [--list]  Adopt the most recent plain claude session in this directory
  falcon --continue                 Alias for "falcon adopt" (most recent, local)
  falcon workspace config [--base-ref <ref>] [--remote <name>] [--directory <path>]
  falcon workspace register [--directory <path>] [--name <display-name>]
  falcon workspace list             List registered workspace directories
  falcon workspace unregister [--directory <path>]
  falcon workspace sync             (coming soon)
  falcon shim install|uninstall|status
                                     Manage the claude/codex PATH shim (Tier 3 adoption)
  falcon notify -p <message>        Send a test push notification
  falcon --help, -h                 Show this help
  falcon --version, -v              Show the CLI version

Environment: FALCON_BACKEND_URL, FALCON_FRONTEND_URL, FALCON_HOME_DIR,
FALCON_DEBUG=1, FALCON_NO_UPDATE=1, FALCON_NO_SERVICE=1
`;

/**
 * Codex has no local-interactive mode (design §7.7, plan.md §16 "3.4 Codex
 * adapter": "`startLocal()` = null with honest CLI note") — `falcon codex`
 * always runs the programmatic `codex app-server` path, never a real Codex
 * TUI the way `falcon claude` can. Surfaced here, ahead of the (still
 * unimplemented) provider spawn itself, so the honest note reaches the user
 * regardless of how much of `runStart` is wired up yet.
 */
function describeStart(command: Extract<FalconCommand, { type: "start" }>): string {
  const parts = [`falcon: would start a ${command.provider} session`];
  if (command.branch !== undefined) parts.push(`on branch "${command.branch}"`);
  if (command.providerArgs.length > 0) parts.push(`with args: ${command.providerArgs.join(" ")}`);
  parts.push("(provider spawning not implemented yet)");
  const note = command.provider === "codex" ? `\n${CODEX_NO_LOCAL_MODE_NOTE}\n` : "";
  return `${parts.join(" ")}\n${note}`;
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
 * `falcon doctor` (+ `falcon doctor clean`) — process discovery/
 * categorization (`doctor.ts`) and, for `clean`, the runaway-kill escape
 * hatch (plan.md §16 "3.2 Durability"). Deliberately does **not** call
 * `ensureDaemon()` first, unlike every other subcommand above — `doctor`
 * exists specifically to be useful when the daemon is wedged or gone
 * entirely (same rationale as `falcon kill`'s process-scan-only discovery).
 */
async function runDoctorCommand(
  command: Extract<FalconCommand, { type: "doctor" }>,
): Promise<number> {
  if (command.action === "report") {
    const report = await runDoctor(createDoctorDeps({ homeDir: resolveHomeDir() }));
    process.stdout.write(describeDoctorReport(report));
    return 0;
  }

  const summary = await runDoctorClean();
  process.stdout.write(describeDoctorCleanSummary(summary));
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
  const deps = createDaemonCommandDeps({ version: readVersion(), bundlePath: resolveBundlePath() });
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
 *
 * A successful `login` additionally offers the FR-9.6 shell-shim opt-in
 * prompt (`./shim/onboardingPrompt.js`) — the first moment a fresh install
 * has proven there's a real account behind it. `logout`/`status` never
 * trigger it, and it's a no-op past the first successful login regardless
 * (see `maybePromptShimOptIn`'s own `onboardingCompleted` gate).
 */
async function runAuth(command: Extract<FalconCommand, { type: "auth" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  const code = await runAuthCommand(command.action, logger);
  if (command.action === "login" && code === 0) {
    await maybePromptShimOptIn();
  }
  return code;
}

/**
 * `falcon shim install|uninstall|status` (falcon-prd.md FR-9.6, plan.md §16
 * "4.2 Adoption Tier 3 + polish") — see `commands/shim.ts` for the actual
 * bin/PATH-block logic. Deliberately does **not** call `ensureDaemon()`,
 * same rationale as `workspace config`/`workspace register`: no daemon
 * interaction at all, just local filesystem writes under `~/.falcon/bin`
 * and the user's shell rc file.
 */
async function runShim(command: Extract<FalconCommand, { type: "shim" }>): Promise<number> {
  return runShimCommand(command.action);
}

/**
 * `falcon sessions list` (plan.md §16 "4.2 Adoption Tier 3 + polish") — see
 * `commands/sessionsList.ts` for the actual local+remote listing logic.
 * `ensureDaemon()` runs first for consistency with every other
 * agent-adjacent subcommand (PRD FR-1.2), even though the listing itself
 * doesn't talk to this machine's daemon (only to the server, over HTTP).
 */
async function runSessions(command: Extract<FalconCommand, { type: "sessions" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  logger.debug("sessions command", { action: command.action });
  return runSessionsListCommand({ workingDirectory: process.cwd(), logger });
}

/**
 * `falcon resume <session-id>` (plan.md §16 "4.2 Adoption Tier 3 + polish")
 * — see `commands/resume.ts` for the local-vs-daemon-managed dispatch logic.
 */
async function runResume(command: Extract<FalconCommand, { type: "resume" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  return runResumeCommand(command.sessionId, {
    homeDir: resolveHomeDir(),
    workingDirectory: process.cwd(),
    logger,
  });
}

/**
 * `falcon adopt [--remote] [--list]` / `falcon --continue` (plan.md §16
 * "3.3 Session adoption (UC9)") — see `commands/adopt.ts` for the actual
 * listing/resume/lineage logic. `ensureDaemon()` runs first for
 * consistency with every other agent-adjacent subcommand (PRD FR-1.2):
 * `--remote`'s detached child self-reports to the daemon's control server
 * the same way any other spawned session does.
 */
async function runAdopt(command: Extract<FalconCommand, { type: "adopt" }>): Promise<number> {
  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  return runAdoptCommand(
    { list: command.list, remote: command.remote },
    createAdoptCommandDeps({ workingDirectory: process.cwd() }, { logger }),
  );
}

/**
 * `falcon workspace config [--base-ref/--remote/--directory]` (plan.md §16
 * "4.1 Git panel") — reads/writes `~/.falcon/settings.json` directly (see
 * `commands/workspaceConfig.ts`). Deliberately does **not** call
 * `ensureDaemon()`: unlike `adopt`/`start`/`auth`, this command has no
 * daemon interaction at all — the daemon's `git.diff` RPC handler reads the
 * same store straight off disk the next time it runs, same rationale as
 * `doctor` skipping the daemon-auto-start step.
 */
async function runWorkspaceConfig(
  command: Extract<FalconCommand, { type: "workspace-config" }>,
): Promise<number> {
  return runWorkspaceConfigCommand(
    { baseRef: command.baseRef, remote: command.remote, directory: command.directory },
    { workingDirectory: process.cwd() },
  );
}

/**
 * `falcon workspace register|list|unregister` (plan.md §16 "3.1 Remote
 * spawn" / "3.3 Session adoption (UC9)") — reads/writes
 * `~/.falcon/workspaces.json` directly (see `commands/workspaceRegister.ts`
 * / `workspace/registry.ts`). Same rationale as `workspace-config` for
 * skipping `ensureDaemon()`: no daemon interaction, a real daemon reads the
 * same store off disk whenever it next needs it.
 */
async function runWorkspaceRegister(
  command: Extract<FalconCommand, { type: "workspace-register" }>,
): Promise<number> {
  return runWorkspaceRegisterCommand(
    { directory: command.directory, name: command.name },
    { workingDirectory: process.cwd() },
  );
}

async function runWorkspaceList(): Promise<number> {
  return runWorkspaceListCommand({ workingDirectory: process.cwd() });
}

async function runWorkspaceUnregister(
  command: Extract<FalconCommand, { type: "workspace-unregister" }>,
): Promise<number> {
  return runWorkspaceUnregisterCommand(
    { directory: command.directory },
    { workingDirectory: process.cwd() },
  );
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
    case "doctor":
      return runDoctorCommand(command);
    case "sessions":
      return runSessions(command);
    case "resume":
      return runResume(command);
    case "adopt":
      return runAdopt(command);
    case "shim":
      return runShim(command);
    case "workspace-config":
      return runWorkspaceConfig(command);
    case "workspace-register":
      return runWorkspaceRegister(command);
    case "workspace-list":
      return runWorkspaceList();
    case "workspace-unregister":
      return runWorkspaceUnregister(command);
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
