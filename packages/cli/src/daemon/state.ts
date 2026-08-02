import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DaemonState {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
  /**
   * The server-assigned machine id, once this daemon has registered (or
   * resumed) a machine row via `POST /v1/machines` (`machineClient.ts`).
   * Absent until the first successful registration; round-tripping it
   * through this file is what lets a restarted daemon resume the same
   * server-side machine row instead of registering a brand new one every
   * time it boots.
   */
  machineId?: string;
  /**
   * This machine's DEK, wrapped to the account's content public key (base64).
   * Persisted so a restarted daemon recovers the same DEK rather than minting
   * a mismatched one — the CAS-update path never re-sends or rotates `dek`
   * after the initial registration.
   */
  wrappedDek?: string;
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
    typeof candidate.startedAt === "number" &&
    (candidate.machineId === undefined || typeof candidate.machineId === "string") &&
    (candidate.wrappedDek === undefined || typeof candidate.wrappedDek === "string")
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

/**
 * Removes `daemon.state.json`, if present. Used by `kvy daemon stop` (and
 * by the daemon's own shutdown path) once the daemon is confirmed gone —
 * a missing file is treated as already-cleared, matching every other
 * "safe to call more than once" cleanup helper in this package (see
 * `lock.ts`'s `release()`).
 */
export async function clearDaemonState(homeDir: string): Promise<void> {
  await unlink(daemonStatePath(homeDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
