import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * `~/.falcon/daemon.state.json` — the daemon's published identity (design
 * §7.2, plan.md line 691). Written once by the daemon after it binds its
 * control port and successfully acquires the singleton lock (see `lock.ts`);
 * read by any `falcon` command that needs to find the running daemon (e.g.
 * `ensureDaemonRunning()`, `falcon daemon status` — both later bullets).
 *
 * This module only owns the read/write helpers for that file. It is
 * deliberately dumb: no locking, no staleness logic — `lock.ts` is the
 * source of truth for "is a daemon actually running", this is just its
 * advertised metadata.
 */
export interface DaemonState {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
}

export function daemonStatePath(homeDir: string): string {
  return path.join(homeDir, "daemon.state.json");
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pid === "number" &&
    typeof candidate.port === "number" &&
    typeof candidate.version === "string" &&
    typeof candidate.startedAt === "number"
  );
}

export async function writeDaemonState(homeDir: string, state: DaemonState): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(daemonStatePath(homeDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Returns `null` when the file is missing, unreadable, or does not parse
 * into a well-formed `DaemonState` — callers treat "no state" the same as
 * "corrupt state" (both mean: don't trust that a daemon is running from
 * this file alone).
 */
export async function readDaemonState(homeDir: string): Promise<DaemonState | null> {
  try {
    const raw = await readFile(daemonStatePath(homeDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isDaemonState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
