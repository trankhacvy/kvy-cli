/**
 * Process-scan primitive: enumerate the OS process list via `ps`.
 *
 * Works even when the daemon is wedged — deliberately never reads
 * `daemon.state.json` or calls the control server. macOS/Linux only.
 */

import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Full command line (argv joined), collapsed to single-space separators. */
  command: string;
}

/**
 * Parses `ps -axo pid=,ppid=,command=` style output: no header row, one
 * process per line, `pid` then `ppid` then the rest of the line is the
 * full command. Exported standalone so tests can exercise classification
 * logic against a fixed `ps` transcript fixture without shelling out to a
 * real `ps` binary.
 */
export function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = (match[3] ?? "").trim();
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    entries.push({ pid, ppid, command });
  }
  return entries;
}

/**
 * Runs `ps` and resolves with its raw stdout, or `""` on any failure
 * (missing binary, non-zero exit, etc). Wrapped by hand rather than via
 * `util.promisify(execFile)` so the resolved shape is simple and stable
 * under mocking in tests (no dependence on `execFile`'s built-in
 * `promisify.custom` symbol, which a full `node:child_process` mock
 * doesn't carry).
 */
function runPs(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(stdout.toString());
    });
  });
}

/**
 * Lists every process currently visible to this OS user. Best-effort: if
 * `ps` is unavailable or fails, returns an empty list rather than throwing
 * — callers (the `kvy kill` commands) treat "found nothing" as a safe,
 * honest outcome, never a crash. This mirrors the rest of the design's
 * "no silent failures, but also no crashing the escape hatch" stance —
 * the caller surfaces "0 processes found" to the user either way.
 */
export async function listProcesses(): Promise<ProcessEntry[]> {
  const output = await runPs(["-axo", "pid=,ppid=,command="]);
  return parsePsOutput(output);
}

/**
 * Resolves a pid's current working directory — the signal the transcript
 * indexer (`transcriptIndexer.ts`) uses to tell whether a plain `claude`
 * process found by `listProcesses()` is actually running in a given
 * registered workspace (`ps`'s command line alone never includes cwd). Two
 * platform-specific strategies, matching this file's own "macOS/Linux only"
 * scope note:
 *
 *  - **Linux**: `/proc/<pid>/cwd` is a symlink to the live cwd — a single
 *    `readlink`, no subprocess.
 *  - **macOS**: no `/proc`; shells out to `lsof -a -d cwd -p <pid> -Fn`,
 *    which (restricted to the `cwd` file descriptor via `-d cwd`) prints
 *    exactly one `n<path>` line for a live pid.
 *
 * Best-effort like the rest of this file: any failure (pid gone, permission
 * denied, `lsof` missing, unsupported platform) resolves `null` rather than
 * throwing or rejecting — a liveness signal that can't be determined is
 * "unknown", not a crash.
 */
export async function resolveProcessCwd(
  pid: number,
  currentPlatform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (currentPlatform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (currentPlatform === "darwin") {
    return new Promise((resolve) => {
      execFile(
        "lsof",
        ["-a", "-d", "cwd", "-p", String(pid), "-Fn"],
        { maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const nameLine = stdout
            .toString()
            .split("\n")
            .find((line) => line.startsWith("n"));
          resolve(nameLine ? nameLine.slice(1) : null);
        },
      );
    });
  }

  return null;
}
