#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArgParseError, type FalconCommand, parseArgs } from "./args.js";
import { runAuthCommand } from "./auth/index.js";
import { ensureLoggedIn } from "./auth/login.js";
import { runAdaptersInstallCommand, runAdaptersUpgradeCommand } from "./commands/adapters.js";
import { createAdoptCommandDeps, runAdoptCommand } from "./commands/adopt.js";
import { runGithubLogin, runGithubLogout, runGithubStatus } from "./commands/github.js";
import { runKeysApproveCommand } from "./commands/keysApprove.js";
import { runResumeCommand } from "./commands/resume.js";
import { runDaemonServiceCommand } from "./commands/serviceInstall.js";
import { runSessionsListCommand } from "./commands/sessionsList.js";
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
import { ensureBranchWorkspace, GitWorktreeError } from "./daemon/gitWorktree.js";
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
import { runStart as dispatchStart } from "./provider/dispatch.js";
import { providerIdForSubcommand } from "./provider/registry.js";
import { maybeTriggerAutoUpdate } from "./update/autoUpdateTrigger.js";
import { runUpdateCommand } from "./update/runUpdateCommand.js";

// Scaffolding note (plan.md §16, "1.3 CLI skeleton + local mode"): most of
// this module still wires up arg parsing + a stub dispatcher. `auth` is now
// a real implementation (`./auth/`, falcon-plan.md §2.2); daemon control is
// real too (`./daemon/`); `workspace-config` is real too (`./commands/
// workspaceConfig.js`, plan.md §16 "4.1 Git panel"); `workspace-sync` is a
// deliberate, permanent stub (falcon-prd.md line 149: "cloud sync coming
// soon" — sandboxing is out of scope); `falcon claude` now spawns a real
// local session (`./commands/start.js`, see `runStart()` below) — every
// other provider (`codex` has no local-interactive mode, see
// `CODEX_NO_LOCAL_MODE_NOTE`) still goes through the honest `describeStart`
// placeholder below, not a half-implementation.
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

/**
 * `bun build --compile` standalone binaries (scripts/build-binaries.sh,
 * plan.md §16 "4.3 Distribution & self-host") have no on-disk
 * `package.json` sibling to read at runtime — the compile step bakes this
 * identifier in via `--define:__FALCON_CLI_VERSION__` instead. Plain
 * Node/npm installs (dev, and `npm install -g falcon`) never define it, so
 * `typeof` sees "undefined" there and falls through to the normal
 * package.json read below unchanged.
 */
declare const __FALCON_CLI_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __FALCON_CLI_VERSION__ !== "undefined") return __FALCON_CLI_VERSION__;
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

/**
 * `scripts/falcon_claude_launcher.cjs` — same bundle-vs-dev path resolution
 * as `resolveBundlePath()` above (one level below the package root either
 * way), and for the same reason: a nested module's own `import.meta.url`
 * would resolve to `dist/index.mjs` itself once pkgroll inlines everything
 * into that single file, not to wherever the *source* module used to live.
 */
function resolveClaudeLauncherPath(): string {
  return path.join(packageRootDir(), "scripts", "falcon_claude_launcher.cjs");
}

/** `true` for a `bun build --compile` standalone binary — see `readVersion()`'s doc comment above for why this identifier only exists at all in a compiled build. Shared with `update/installKind.ts`, which can't reference `__FALCON_CLI_VERSION__` directly since it's declared in this module's scope only. */
function isCompiledBinary(): boolean {
  return typeof __FALCON_CLI_VERSION__ !== "undefined";
}

const HELP_TEXT = `falcon: wrapper CLI for Claude Code / Codex agent sessions

Usage:
  falcon                            Start a session with the default provider
  falcon claude [args...]           Start a Claude Code session (flags pass through)
  falcon codex [args...]            Start a Codex session (beta, no local TUI, flags pass through)
  falcon -b <branch>                Start a session on a new git worktree/branch
  falcon auth login|logout|status   Manage Falcon account auth
  falcon daemon start [--no-wait] | start-sync | stop | status
                                     Manage the background daemon
  falcon daemon service install|uninstall|status
                                     Register the daemon as a login service (launchd/systemd-user)
  falcon kill daemon|sessions|all|all-force
                                     Process management escape hatches
  falcon doctor [clean]              Discover/categorize Falcon processes (clean: kill runaways)
  falcon sessions list              List sessions (local, and this account's remote/other-machine)
  falcon resume <session-id>        Reattach a terminal to an existing local or daemon-managed session
  falcon adopt [--remote] [--list]  Adopt the most recent plain claude session in this directory
  falcon --continue                 Alias for "falcon adopt" (most recent, local)
  falcon workspace config [--base-ref <ref>] [--remote <name>] [--setup-script <script>] [--run-script <script>] [--directory <path>]
  falcon workspace register [--directory <path>] [--name <display-name>]
  falcon workspace list             List registered workspace directories
  falcon workspace unregister [--directory <path>]
  falcon workspace sync             (coming soon)
  falcon keys approve              Send your keys to another device that asked for them
  falcon adapters install|upgrade   Install/upgrade the pinned ACP adapter packages
  falcon github login [--token] [--client-id <id>] | logout | status
                                     Connect this machine to GitHub for PR/CI checks
  falcon update                     Check for and install a newer falcon version
  falcon notify -p <message>        Send a test push notification
  falcon --help, -h                 Show this help
  falcon --version, -v              Show the CLI version

Environment: FALCON_BACKEND_URL, FALCON_FRONTEND_URL, FALCON_HOME_DIR,
FALCON_DEBUG=1, FALCON_NO_UPDATE=1, FALCON_NO_SERVICE=1
`;

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

  // Auto-update-on-start (plan.md §16 "4.3 Distribution & self-host") shares
  // this same "runs ahead of every agent-invoking subcommand" entry point as
  // the daemon auto-start above (PRD FR-1.2). `maybeTriggerAutoUpdate` does
  // no network I/O itself — it only rate-limits via a local timestamp and
  // spawns a detached background child — so awaiting it here adds no
  // meaningful latency and can never block on a failed/slow update check;
  // it also never throws, so this is safe unconditionally.
  await maybeTriggerAutoUpdate({
    isCompiledBinary: isCompiledBinary(),
    bundlePath: resolveBundlePath(),
    env: process.env,
    homeDir: resolveHomeDir(),
    logger,
  });

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
 * `falcon daemon service install|uninstall|status` (falcon-prd.md FR-4.1
 * "installable as a login service (launchd / systemd-user) [P1]",
 * falcon-system-design.md §8 "Service install (P1)") — see
 * `commands/serviceInstall.ts` for the CLI-facing dispatch and
 * `daemon/serviceInstall.ts` for the actual launchd/systemd logic.
 * Deliberately does **not** call `ensureDaemon()`: this only registers/
 * removes the OS-level service definition (a plist/unit file plus a
 * `launchctl`/`systemctl` call) — the running daemon it points at is a
 * separate concern, same rationale as `workspace config` skipping daemon
 * auto-start.
 */
async function runDaemonService(
  command: Extract<FalconCommand, { type: "daemon-service" }>,
): Promise<number> {
  return runDaemonServiceCommand(command.action);
}

/**
 * `falcon update` (plan.md §16 "4.3 Distribution & self-host") — checks the
 * `cli-latest` rolling release tag and, if a newer version is published,
 * downloads and atomically replaces the running standalone binary (or
 * shells out to `npm install -g falcon@<version>` for an npm install).
 * Deliberately does **not** call `ensureDaemon()`: unlike `start`/`auth`/
 * etc., updating the CLI itself has no daemon interaction, and running it
 * ahead of a daemon auto-start would also re-trigger the very
 * auto-update-on-start check this command *is* — the background variant of
 * this same code path (`update/autoUpdateTrigger.ts`'s detached child).
 */
async function runUpdate(): Promise<number> {
  const { code, message } = await runUpdateCommand({
    currentVersion: readVersion(),
    isCompiledBinary: isCompiledBinary(),
    bundlePath: resolveBundlePath(),
    execPath: process.execPath,
    env: process.env,
    logger,
  });
  if (message) process.stdout.write(message);
  return code;
}

/**
 * Resolves `falcon -b <branch>`'s local-mode target directory
 * (known-issues.md #2 first bullet — local `-b` used to be parsed and then
 * silently dropped, only remote `spawn` ever created a worktree). Mirrors
 * `spawnEngine.ts`'s own `ensureBranchWorkspace` call: always
 * `createWorktree: true`, no `from` (a bare `-b` forks off whatever's
 * currently checked out at the repo, same as the old in-place-checkout
 * behavior this flag had before worktree isolation existed). No `branch`
 * means the current working directory, unchanged.
 */
export async function resolveStartWorkingDirectory(
  branch: string | undefined,
): Promise<{ ok: true; directory: string } | { ok: false; message: string }> {
  if (branch === undefined) {
    return { ok: true, directory: process.cwd() };
  }
  try {
    const repoDirectory = await realpath(process.cwd());
    const { directory } = await ensureBranchWorkspace({
      repoDirectory,
      branch: { name: branch, createWorktree: true },
    });
    return { ok: true, directory };
  } catch (error) {
    const message = error instanceof GitWorktreeError ? error.message : String(error);
    return { ok: false, message: `falcon -b ${branch}: ${message}` };
  }
}

/**
 * `falcon` / `falcon claude` / `falcon codex` — the primary agent-invoking
 * entrypoint. `claude` spawns a real local session (`./commands/start.js`,
 * wiring `session/bootstrap.ts` + `api/outbox.ts` + `claude/loop.ts` — every
 * one of those was already built and unit-tested in isolation before this
 * function existed to call them); `codex` (no local-interactive mode, see
 * `CODEX_NO_LOCAL_MODE_NOTE`) and any other provider still go through the
 * honest `describeStart` stub. The daemon auto-start this depends on (PRD
 * FR-1.2) is real either way: this is the first place a fresh install
 * actually touches the daemon.
 *
 * Auth is checked *before* the daemon is started (`ensureLoggedIn()`, first-run
 * UX): the daemon only attempts machine registration once, at its own startup,
 * and only if credentials already exist at that moment — starting it ahead of a
 * first-time login would risk a daemon that came up with nothing to register and
 * never retries. Checking (and, at a real TTY, completing) login first means the
 * daemon always sees credentials the one time it looks.
 *
 * This ordering is load-bearing: `commands/start.ts` deliberately does NOT run
 * the inline login itself, because it executes after `ensureDaemon()` below.
 * Its own re-pair path (a dead refresh token) therefore asks the daemon to
 * reload credentials afterwards (`daemon/reloadAuth.ts`).
 */
async function runStart(command: Extract<FalconCommand, { type: "start" }>): Promise<number> {
  // Every provider, not just claude (AX-1.1) — `startCodex` had the same
  // read-credentials-then-hard-fail shape, and both now depend on this having run.
  const auth = await ensureLoggedIn(logger);
  if (!auth.ok) {
    if (auth.message) process.stderr.write(auth.message);
    return 1;
  }

  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }

  const workingDirectory = await resolveStartWorkingDirectory(command.branch);
  if (!workingDirectory.ok) {
    process.stderr.write(`${workingDirectory.message}\n`);
    return 1;
  }

  const providerId = providerIdForSubcommand(command.provider);
  if (!providerId) {
    process.stderr.write(`falcon: unknown provider "${command.provider}"\n`);
    return 1;
  }

  return dispatchStart(providerId, {
    homeDir: resolveHomeDir(),
    workingDirectory: workingDirectory.directory,
    providerArgs: command.providerArgs,
    logger,
    launcherPath: providerId === "claude-code" ? resolveClaudeLauncherPath() : undefined,
  });
}

/**
 * `falcon auth login|logout|status` (plan.md §5, design §5) — the real
 * OAuth browser flow + pairing fallback lives in `./auth/`.
 *
 * `login` specifically runs *before* `ensureDaemon()` (same rationale as
 * `runStart`'s claude path): the daemon only attempts
 * machine registration once, at its own startup, and only if credentials
 * already exist at that moment. A fresh install's very first command is
 * commonly `falcon auth login` — starting the daemon ahead of that would
 * risk it coming up with nothing to register and never retrying, even
 * moments later once login succeeds. `logout`/`status` don't create
 * credentials, so for them `ensureDaemon()` still runs first, consistent
 * with every other agent-adjacent subcommand (PRD FR-1.2).
 *
 */
async function runAuth(command: Extract<FalconCommand, { type: "auth" }>): Promise<number> {
  if (command.action === "login") {
    const code = await runAuthCommand(command.action, logger);
    const daemon = await ensureDaemon();
    if (!daemon.ok) {
      process.stderr.write(daemon.message);
      return 1;
    }
    return code;
  }

  const daemon = await ensureDaemon();
  if (!daemon.ok) {
    process.stderr.write(daemon.message);
    return 1;
  }
  return runAuthCommand(command.action, logger);
}

/**
 * `falcon adapters install|upgrade` (design §7.9, plan.md §16 "Phase 2.0 —
 * foundation") — see `commands/adapters.ts` / `adapters/install.ts` for the
 * actual npm-prefix install + integrity-verification logic. Deliberately
 * does **not** call `ensureDaemon()`, same rationale as `workspace config`:
 * a local filesystem/npm operation under `~/.falcon/adapters`, no daemon
 * interaction at all.
 */
async function runAdapters(command: Extract<FalconCommand, { type: "adapters" }>): Promise<number> {
  const deps = { homeDir: resolveHomeDir() };
  return command.action === "install"
    ? runAdaptersInstallCommand(deps)
    : runAdaptersUpgradeCommand(deps);
}

/**
 * `falcon github login|logout|status` (docs/features/github-pr-ci.md
 * "GITHUB AUTH") — see `commands/github.ts` for the token-store/device-flow
 * logic. Deliberately does **not** call `ensureDaemon()`, same rationale as
 * `workspace config`/`adapters`: a local `~/.falcon/github.key` write
 * plus a direct GitHub API call, no daemon interaction at all — the
 * daemon's `github.checks` RPC handler reads the same token file fresh off
 * disk on its own next call.
 */
async function runGithub(command: Extract<FalconCommand, { type: "github" }>): Promise<number> {
  const deps = { homeDir: resolveHomeDir() };
  switch (command.action) {
    case "login":
      return runGithubLogin({ useToken: command.token, clientId: command.clientId }, deps);
    case "logout":
      return runGithubLogout(deps);
    case "status":
      return runGithubStatus(deps);
  }
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
 * `falcon workspace config [--base-ref/--remote/--setup-script/--run-script/
 * --directory]` (plan.md §16 "4.1 Git panel"; docs/features/
 * setup-run-scripts.md) — reads/writes `~/.falcon/settings.json` directly
 * (see `commands/workspaceConfig.ts`). Deliberately does **not** call
 * `ensureDaemon()`: unlike `adopt`/`start`/`auth`, this command has no
 * daemon interaction at all — the daemon's `git.diff` RPC handler (and, as
 * of setup-run-scripts, `setupScript.ts`/`runProcess.ts`) reads the same
 * store straight off disk the next time it runs, same rationale as `doctor`
 * skipping the daemon-auto-start step.
 */
async function runWorkspaceConfig(
  command: Extract<FalconCommand, { type: "workspace-config" }>,
): Promise<number> {
  return runWorkspaceConfigCommand(
    {
      baseRef: command.baseRef,
      remote: command.remote,
      setupScript: command.setupScript,
      runScript: command.runScript,
      directory: command.directory,
    },
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
    case "daemon-service":
      return runDaemonService(command);
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
    case "keys":
      return runKeysApproveCommand({ logger });
    case "adapters":
      return runAdapters(command);
    case "github":
      return runGithub(command);
    case "update":
      return runUpdate();
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
  process.stderr.write("falcon: unexpected error. See ~/.falcon/logs for details\n");
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
