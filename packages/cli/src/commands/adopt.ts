/**
 * `falcon adopt [--remote] [--list]` + `falcon --continue` alias (design
 * §7.8 FR-9.2, plan.md §16 "3.3 Session adoption (UC9)"): the
 * terminal-side half of adoption — "I started plain `claude`, now move it
 * to Falcon."
 *
 * `--list`: enumerate plain sessions for the current directory's workspace
 * (`adopt/listSessions.ts`), most-recently-active first, and print them —
 * no side effects.
 *
 * Default (no `--list`): preselect the most recent session and continue
 * it via Claude Code's own native resume:
 *  - **local** (default): `claude --resume <id>` spawned with inherited
 *    stdio, so the user gets the real interactive TUI back, blocking until
 *    it exits. Since Claude Code mints a brand-new provider session id on
 *    `--resume` (plan.md §11: "documented in `happy-cli/CLAUDE.md`
 *    'Session Forking'"), this snapshots the project dir's session ids
 *    before the child runs and diffs afterward to discover the new id,
 *    then records the old→new lineage (`adopt/lineage.ts`) — no hook
 *    wiring needed, since the exact id we're resuming from is already
 *    known going in.
 *  - **`--remote`**: launches `falcon claude --starting-mode remote
 *    --continue-from <id>` detached (tmux-preferred, same launcher the
 *    daemon's `spawn` RPC uses) instead of blocking the terminal. The new
 *    session's own provider session id isn't known synchronously in this
 *    path (no hook server wired to this ad hoc launch), so lineage
 *    recording is deferred — printed as an explicit, honest note rather
 *    than silently skipped.
 *
 * `falcon --continue` aliases the flagless case (most-recent, local) —
 * wired in `args.ts`/`index.ts`.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ProviderSessionSummary } from "@falcon/wire";
import crossSpawnDefault from "cross-spawn";
import { recordAdoptionLineage } from "../adopt/lineage.js";
import { listAdoptableSessions } from "../adopt/listSessions.js";
import type { LivenessDeps } from "../adopt/liveness.js";
import { getProjectPath } from "../claude/scanner.js";
import {
  type LaunchProcessDeps,
  launchProviderProcess as launchProviderProcessDefault,
  type SpawnFn,
} from "../daemon/processLauncher.js";
import type { Logger } from "../logger.js";
import type { PersistenceOptions } from "../persistence.js";

const JSONL_EXT = ".jsonl";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface AdoptCommandOptions {
  list: boolean;
  remote: boolean;
}

export interface AdoptCommandDeps {
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  liveness?: LivenessDeps;
  /** Injectable for tests; defaults to `cross-spawn`'s `spawn`, run with inherited stdio for the local resume path. */
  spawnImpl?: SpawnFn;
  /** Injectable for tests; defaults to the real tmux-preferred/detached launcher, for the `--remote` path. */
  launchProcess?: typeof launchProviderProcessDefault;
  launchDeps?: LaunchProcessDeps;
  /** Returns the argv that re-invokes this same falcon binary (`[node, ...execArgv, entry]`) — same convention as `spawnEngine.ts`'s `defaultFalconEntrypoint`. */
  falconEntrypoint?: () => string[];
  /** Forwarded to `adopt/lineage.ts`'s `recordAdoptionLineage` — overrides `~/.falcon`'s location (tests only; defaults to the real home dir). */
  persistenceOptions?: PersistenceOptions;
  write?: (text: string) => void;
  logger?: Logger;
}

function defaultFalconEntrypoint(): string[] {
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  return [process.execPath, ...process.execArgv, entry];
}

/** Real, OS-backed defaults for anything not overridden. */
export function createAdoptCommandDeps(
  required: Pick<AdoptCommandDeps, "workingDirectory">,
  overrides: Partial<AdoptCommandDeps> = {},
): AdoptCommandDeps {
  return {
    env: process.env,
    write: (text: string) => process.stdout.write(text),
    ...required,
    ...overrides,
  };
}

function formatSessionList(sessions: ProviderSessionSummary[]): string {
  if (sessions.length === 0) return "";
  const lines = sessions.map((s) => {
    const when = new Date(s.lastActivityAt).toISOString();
    const marker = s.running ? " [running]" : "";
    return `  ${s.providerSessionId}  ${when}  ${s.title ?? "(untitled)"}${marker}`;
  });
  return `${lines.join("\n")}\n`;
}

async function listJsonlIds(projectDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(projectDir);
    return new Set(
      entries
        .filter((name) => name.endsWith(JSONL_EXT))
        .map((name) => name.slice(0, -JSONL_EXT.length)),
    );
  } catch {
    return new Set();
  }
}

/** After a local `--resume` run exits, finds a `.jsonl` id present now that wasn't in `before` — the new session Claude Code minted. `null` if none appeared (e.g. resume reused the same id). */
async function detectNewSessionId(projectDir: string, before: Set<string>): Promise<string | null> {
  const after = await listJsonlIds(projectDir);
  for (const id of after) {
    if (!before.has(id)) return id;
  }
  return null;
}

async function runLocalAdopt(
  target: ProviderSessionSummary,
  deps: Required<Pick<AdoptCommandDeps, "workingDirectory" | "write">> & AdoptCommandDeps,
  logger: Logger,
): Promise<number> {
  const env = deps.env ?? process.env;
  const projectDir = getProjectPath(deps.workingDirectory, env);
  const before = await listJsonlIds(projectDir);

  const spawnImpl = deps.spawnImpl ?? (crossSpawnDefault as unknown as SpawnFn);
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawnImpl("claude", ["--resume", target.providerSessionId], {
      cwd: deps.workingDirectory,
      env,
      stdio: "inherit",
    });
    child.once("error", (error: Error) => {
      logger.error("[adopt] failed to launch claude --resume", { message: error.message });
      resolve(1);
    });
    child.once("close", (code: number | null) => resolve(code ?? 0));
  });

  const newId = await detectNewSessionId(projectDir, before);
  if (newId && newId !== target.providerSessionId) {
    const chain = await recordAdoptionLineage(
      target.providerSessionId,
      newId,
      deps.persistenceOptions,
    );
    deps.write(`falcon adopt: recorded lineage ${chain.join(" -> ")}\n`);
  }

  return exitCode;
}

async function runRemoteAdopt(
  target: ProviderSessionSummary,
  deps: Required<Pick<AdoptCommandDeps, "workingDirectory" | "write">> & AdoptCommandDeps,
  logger: Logger,
): Promise<number> {
  const launch = deps.launchProcess ?? launchProviderProcessDefault;
  const [command, ...prefixArgs] = deps.falconEntrypoint?.() ?? defaultFalconEntrypoint();
  if (!command) {
    deps.write("falcon adopt --remote: could not resolve the falcon entrypoint to re-invoke\n");
    return 1;
  }
  const args = [
    ...prefixArgs,
    "claude",
    "--starting-mode",
    "remote",
    "--started-by",
    "adopt",
    "--continue-from",
    target.providerSessionId,
  ];

  try {
    const launched = await launch(
      {
        sessionLabel: `adopt-${target.providerSessionId}`,
        command,
        args,
        cwd: deps.workingDirectory,
        env: deps.env ?? process.env,
      },
      deps.launchDeps,
    );
    deps.write(
      `falcon adopt --remote: launched detached session (pid ${launched.pid}, ${launched.method}) continuing from ${target.providerSessionId}\n`,
    );
    deps.write(
      "falcon adopt --remote: lineage recording for the new session id isn't wired for detached starts yet — it lands once managed-session registration does\n",
    );
    return 0;
  } catch (error) {
    logger.error("[adopt] failed to launch detached remote session", {
      message: error instanceof Error ? error.message : String(error),
    });
    deps.write(
      `falcon adopt --remote: failed to launch — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

/** Runs `falcon adopt`/`falcon --continue`. Returns the process exit code. */
export async function runAdoptCommand(
  options: AdoptCommandOptions,
  deps: AdoptCommandDeps,
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const logger = deps.logger ?? noopLogger;
  const env = deps.env ?? process.env;

  const sessions = await listAdoptableSessions({
    workingDirectory: deps.workingDirectory,
    env,
    liveness: deps.liveness,
  });

  if (sessions.length === 0) {
    write(`falcon adopt: no plain Claude Code sessions found for ${deps.workingDirectory}\n`);
    return 0;
  }

  if (options.list) {
    write(formatSessionList(sessions));
    return 0;
  }

  const target = sessions[0];
  if (!target) {
    // Unreachable given the length check above; guards `noUncheckedIndexedAccess` honestly instead of a non-null assertion.
    write(`falcon adopt: no plain Claude Code sessions found for ${deps.workingDirectory}\n`);
    return 0;
  }
  const runningNote = target.running ? " — currently running" : "";
  write(
    `falcon adopt: adopting "${target.title ?? target.providerSessionId}" (${target.providerSessionId})${runningNote}\n`,
  );

  const fullDeps = { ...deps, write };
  return options.remote
    ? runRemoteAdopt(target, fullDeps, logger)
    : runLocalAdopt(target, fullDeps, logger);
}
