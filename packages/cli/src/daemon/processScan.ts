/**
 * Process-scan primitive: enumerate the OS process list via `ps`.
 *
 * This exists as the discovery mechanism for `falcon kill *` (plan.md
 * §7.2/§7.4, falcon-system-design.md §11 "Wedged provider process ...
 * `falcon kill sessions` escape hatch"): it has to work even when the
 * daemon itself is wedged, so it deliberately never reads
 * `daemon.state.json` and never calls into `controlServer.ts`'s loopback
 * HTTP API — both may be exactly what's broken. It only looks at what the
 * OS actually has running, the same way Happy's `daemon/doctor.ts`
 * (`findAllHappyProcesses`) does.
 *
 * macOS/Linux only (`ps -axo ...`) — Windows support is PRD FR-1.1 P2 and
 * out of scope here, matching the rest of the CLI at this phase.
 */

import { execFile } from "node:child_process";

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
 * — callers (the `falcon kill` commands) treat "found nothing" as a safe,
 * honest outcome, never a crash. This mirrors the rest of the design's
 * "no silent failures, but also no crashing the escape hatch" stance —
 * the caller surfaces "0 processes found" to the user either way.
 */
export async function listProcesses(): Promise<ProcessEntry[]> {
  const output = await runPs(["-axo", "pid=,ppid=,command="]);
  return parsePsOutput(output);
}
