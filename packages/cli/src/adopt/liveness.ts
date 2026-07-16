/**
 * Shared "is a plain (non-Falcon) `claude` process live for this workspace,
 * and which transcript does it own" check (design §7.8/§8, plan.md §16
 * "3.3 Session adoption (UC9)") — used both by `falcon adopt`'s local
 * listing (`adopt/listSessions.ts`) and the daemon's `adopt.take` RPC
 * (`daemon/adoptTake.ts`, to find the pid to signal on takeover).
 *
 * Mirrors `daemon/transcriptIndexer.ts`'s private `isPlainClaudeCommand` +
 * `computeRunning` (same heuristic: a live, non-Falcon `claude` process
 * whose cwd resolves to the workspace path, paired with whichever
 * transcript in that project dir was most recently modified — the file
 * that process is presumed to own). Reimplemented here rather than
 * imported since `transcriptIndexer.ts` doesn't export those symbols and
 * this task's scope deliberately avoids editing that module — kept in
 * lockstep by design: if the indexer's heuristic ever changes, this should
 * change with it.
 */
import { readdir, stat } from "node:fs/promises";
import path, { resolve as resolvePath } from "node:path";
import { classifyFalconCommand } from "../daemon/markers.js";
import {
  listProcesses as listProcessesDefault,
  type ProcessEntry,
  resolveProcessCwd as resolveProcessCwdDefault,
} from "../daemon/processScan.js";

const JSONL_EXT = ".jsonl";

export interface LivenessDeps {
  listProcesses: () => Promise<ProcessEntry[]>;
  resolveProcessCwd: (pid: number) => Promise<string | null>;
}

export function createLivenessDeps(overrides: Partial<LivenessDeps> = {}): LivenessDeps {
  return {
    listProcesses: listProcessesDefault,
    resolveProcessCwd: resolveProcessCwdDefault,
    ...overrides,
  };
}

/** True for a bare `claude` invocation's command line — false for anything Falcon itself launched (`falcon claude ...`). */
export function isPlainClaudeCommand(command: string): boolean {
  if (classifyFalconCommand(command)) return false;
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const first = tokens[0];
  if (!first) return false;
  const base = first.split("/").pop() ?? first;
  return base === "claude";
}

export interface OwningProcess {
  pid: number;
  providerSessionId: string;
}

/**
 * Finds the live, non-Falcon `claude` process rooted at `workspacePath`
 * (if any) and the transcript it's presumed to own — the
 * most-recently-modified `.jsonl` file in `projectDir`. Returns `null` if
 * no live process matches, or the project dir can't be read.
 */
export async function findOwningClaudeProcess(
  workspacePath: string,
  projectDir: string,
  deps: LivenessDeps,
): Promise<OwningProcess | null> {
  const resolvedWorkspace = resolvePath(workspacePath);
  const processes = await deps.listProcesses();

  let livePid: number | null = null;
  for (const proc of processes) {
    if (!isPlainClaudeCommand(proc.command)) continue;
    const cwd = await deps.resolveProcessCwd(proc.pid);
    if (cwd && resolvePath(cwd) === resolvedWorkspace) {
      livePid = proc.pid;
      break;
    }
  }
  if (livePid === null) return null;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  let latestId: string | null = null;
  let latestMtimeMs = -Infinity;
  for (const name of entries) {
    if (!name.endsWith(JSONL_EXT)) continue;
    try {
      const stats = await stat(path.join(projectDir, name));
      if (stats.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stats.mtimeMs;
        latestId = name.slice(0, -JSONL_EXT.length);
      }
    } catch {
      // Raced with a delete/rename between readdir and stat — skip it.
    }
  }
  return latestId === null ? null : { pid: livePid, providerSessionId: latestId };
}
