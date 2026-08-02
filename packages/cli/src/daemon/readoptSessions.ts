/**
 * Boot-time re-adoption: finds persisted sessions whose recorded pid is still a
 * live kvy session process in the recorded directory.
 *
 * After a daemon restart, orphaned children are invisible to
 * `scanForLiveSessionInDirectory` (which only scans live-tracked sessions) until
 * explicitly re-tracked. This module is the discovery half; `sessionRegistry.ts`'s
 * `readoptLiveSessions` owns the map insertion.
 *
 * Guards pid recycling: liveness alone is not enough — the pid's command line must
 * classify as a kvy `session` AND its resolved cwd must match the persisted directory.
 */
import { realpath as realpathDefault } from "node:fs/promises";
import { classifyKvyCommand } from "./markers.js";
import type { ProcessEntry } from "./processScan.js";
import type { PersistedSession } from "./sessionsStore.js";

export interface ReadoptProbeDeps {
  listProcesses: () => Promise<ProcessEntry[]>;
  resolveCwd: (pid: number) => Promise<string | null>;
  realpath?: (p: string) => Promise<string>;
}

export interface ReadoptCandidate {
  sessionId: string;
  session: PersistedSession;
  pid: number;
}

/**
 * Finds persisted sessions whose recorded pid is STILL a live kvy session
 * process running in the recorded directory — the ones a daemon restart
 * orphaned but did not kill. Guards pid recycling: kill(pid,0) alone is NOT
 * enough (a reused pid could be an unrelated process, or another kvy
 * session in a different dir), so the live pid's `ps` command line must
 * classify as a kvy `session` AND its resolved cwd must equal the
 * persisted (realpath-canonicalized) directory.
 */
export async function findLiveOrphanedSessions(
  persisted: Record<string, PersistedSession>,
  deps: ReadoptProbeDeps,
): Promise<ReadoptCandidate[]> {
  const canon = deps.realpath ?? realpathDefault;
  const candidates = Object.entries(persisted).filter(
    ([, s]) => typeof s.pid === "number" && s.pid > 0 && typeof s.directory === "string",
  );
  if (candidates.length === 0) return [];

  const byPid = new Map((await deps.listProcesses()).map((p) => [p.pid, p]));
  const result: ReadoptCandidate[] = [];

  for (const [sessionId, session] of candidates) {
    const pid = session.pid as number;
    const proc = byPid.get(pid);
    if (!proc) continue; // pid not alive

    if (classifyKvyCommand(proc.command)?.kind !== "session") continue; // recycled/unrelated

    const cwd = await deps.resolveCwd(pid);
    if (!cwd) continue;

    let liveDir: string;
    let wantDir: string;
    try {
      liveDir = await canon(cwd);
      wantDir = await canon(session.directory as string);
    } catch {
      continue; // dir deleted/unmounted
    }
    if (liveDir !== wantDir) continue; // wrong dir → not this session

    result.push({ sessionId, session, pid });
  }

  return result;
}
