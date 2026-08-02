/**
 * Kvy process marker convention: argv-based classification of OS processes.
 *
 * `kvy kill *` discovers its targets by process-scan alone, so it needs a
 * documented argv convention for recognizing Kvy processes — an env var isn't
 * usable because reading another process's environment portably requires
 * platform-specific privileges, whereas `ps` gives every process's command line.
 *
 *  - **Daemon**: launched as `kvy daemon start-sync` (detached).
 *  - **Session**: launched as `kvy <provider> --starting-mode remote --started-by daemon`
 *    (or any bare `kvy <provider>` invocation). The `--started-by daemon` flag
 *    distinguishes how it started but not whether it's killable.
 *  - **Other**: short-lived administrative subcommands (`daemon stop/status`,
 *    `kill`, `doctor`, `auth`, etc.) — must never be treated as a kill target.
 *    `doctor` in particular scans the same `ps` output it's itself part of and
 *    must classify its own invocation as "other".
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
