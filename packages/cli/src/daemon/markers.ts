/**
 * Kvy process marker convention (plan.md §7.2/§7.4).
 *
 * `kvy kill *` has to discover its targets by process-scan alone (see
 * `processScan.ts`), so it needs a documented, argv-based convention for
 * recognizing which OS processes are Kvy's — an env var isn't usable
 * here: reading *another* process's environment portably requires
 * platform-specific privileges/APIs, whereas `ps` gives every process's
 * command line for free. This is deliberately the same style Happy —
 * https://github.com/slopus/happy (MIT) — uses in `happy-cli/src/daemon/doctor.ts`'s
 * `findAllHappyProcesses` (`cmd.includes(...)` matching), kept as an
 * explicit convention so the daemon spawner/singleton-lock work (a
 * separate, in-flight task) can stay compatible with it:
 *
 *  - **Daemon**: the daemon's own long-running process is launched as
 *    `kvy daemon start-sync` (the short-lived `daemon start` command
 *    spawns this detached and exits — see Happy's
 *    `spawnHappyCLI(['daemon','start-sync'], {detached:true})` pattern,
 *    `daemon/CLAUDE.md`). Both `start-sync` and a bare `start` still
 *    running are classified as `daemon`.
 *  - **Session**: a daemon-spawned remote session is launched as
 *    `kvy <provider> --starting-mode remote --started-by daemon`
 *    (plan.md §7.3). Every other bare `kvy` / `kvy <provider>`
 *    invocation (local-mode session wrapper) is a session too — the
 *    `--started-by daemon` flag only distinguishes *how* it was started
 *    (`spawnedByDaemon`), not whether it's killable as a session.
 *  - **Other**: Kvy's own short-lived administrative subcommands
 *    (`daemon stop/status`, `kill`, `doctor`, `auth`, `sessions`, `resume`,
 *    `workspace`, `notify`, `--help`/`--version`) are neither a daemon nor
 *    a session — they exit almost immediately and must never be treated
 *    as a kill target. `doctor` matters in particular here: it scans the
 *    same `ps` output it's itself a line of, and must classify its own
 *    invocation as "other", not "session" (plan.md §16 "3.2 Durability").
 */

import type { ProcessEntry } from "./processScan.js";

export type KvyProcessKind = "daemon" | "session" | "other";

export interface ClassifiedProcess extends ProcessEntry {
  kind: KvyProcessKind;
  /** True if this session's argv carries the daemon-spawn marker (`--started-by daemon`). Informational only. */
  spawnedByDaemon: boolean;
}

const ADMIN_SUBCOMMANDS = new Set([
  "daemon",
  "kill",
  "doctor",
  "auth",
  "sessions",
  "resume",
  "workspace",
  "notify",
  "--help",
  "-h",
  "--version",
  "-v",
  "-V",
]);

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Recognizes the Kvy CLI entrypoint token itself (`kvy`, `bin/kvy.mjs`, or the built/dev entry under `packages/cli`). */
function isKvyEntrypointToken(token: string): boolean {
  const base = token.split("/").pop() ?? token;
  if (base === "kvy" || base === "kvy.mjs") return true;
  if ((base === "index.mjs" || base === "index.ts") && token.includes("/cli/")) return true;
  return false;
}

interface KvyClassification {
  kind: KvyProcessKind;
  spawnedByDaemon: boolean;
}

/** Classifies a single `ps` command string, or `null` if it isn't a Kvy process at all. */
export function classifyKvyCommand(command: string): KvyClassification | null {
  const tokens = tokenize(command);
  const entrypointIndex = tokens.findIndex(isKvyEntrypointToken);
  if (entrypointIndex === -1) return null;

  const args = tokens.slice(entrypointIndex + 1);
  const sub = args[0];
  const spawnedByDaemon = args.some((arg, i) => arg === "--started-by" && args[i + 1] === "daemon");

  if (sub === "daemon" && (args[1] === "start-sync" || args[1] === "start")) {
    return { kind: "daemon", spawnedByDaemon: false };
  }
  if (sub !== undefined && ADMIN_SUBCOMMANDS.has(sub)) {
    return { kind: "other", spawnedByDaemon };
  }
  return { kind: "session", spawnedByDaemon };
}

/**
 * Classifies a raw process list into Kvy-owned processes only,
 * excluding `currentPid` (the invoking `kvy kill` process itself must
 * never be a target of its own scan).
 */
export function classifyProcesses(
  processes: ProcessEntry[],
  currentPid: number,
): ClassifiedProcess[] {
  const result: ClassifiedProcess[] = [];
  for (const proc of processes) {
    if (proc.pid === currentPid) continue;
    const classification = classifyKvyCommand(proc.command);
    if (!classification) continue;
    result.push({ ...proc, ...classification });
  }
  return result;
}
