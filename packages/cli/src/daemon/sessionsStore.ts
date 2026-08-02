/**
 * `~/.kvy/sessions.json` — durability store for session records including
 * wrapped DEKs so resume survives daemon restarts.
 *
 * This module owns file read/write/restore mechanics only; `sessionRegistry.ts`
 * decides when to call these. Uses tmp-write + rename atomicity and an in-process
 * write queue to prevent concurrent `persistSession` calls from racing each other's
 * read-modify-write.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_IDS, type ProviderId } from "@kvy/wire";
import type { SessionEncryptionData } from "./types.js";

/**
 * Bumped whenever this shape changes; written into every sessions.json.
 * v2 added the optional `directory` field below; v3 added the optional
 * `pid` field below. No migration branch is needed: the read path
 * (`readPersistedSessions`/`isPersistedSession`) is version-agnostic and
 * both changes are purely additive — an older file whose records have no
 * `directory`/`pid` key still loads fine (`directory`/`pid === undefined`).
 * The bump is only an honest on-disk marker of the current shape.
 */
export const SESSIONS_SCHEMA_VERSION = 3;

/**
 * A single session's durable resume record. `metadata` is whatever opaque
 * blob the session reported via `/session-started` (`controlServer.ts`) —
 * this module never inspects its shape, only round-trips it.
 */
export interface PersistedSession {
  sessionId: string;
  provider?: ProviderId;
  metadata?: unknown;
  encryption: SessionEncryptionData;
  /** `Date.now()` at the time this record was last written — drives expiry below. */
  savedAt: number;
  /**
   * The resolved real (symlink-followed) directory this session was spawned into.
   * Persisted so the spawn-dedup guard survives a daemon restart. Absent for
   * terminal-started sessions and pre-v2 records.
   */
  directory?: string;
  /**
   * The OS pid of the still-live session process. Persisted so daemon boot can
   * re-adopt sessions whose process outlived the restart. Verified against pid
   * recycling on boot — never trusted blindly. Absent from pre-v3 records.
   */
  pid?: number;
}

interface SessionsFileShape {
  schemaVersion: number;
  sessions: Record<string, PersistedSession>;
}

/** A session nobody has resumed in two weeks is not worth carrying forward indefinitely. */
const MAX_SESSION_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function sessionsFilePath(homeDir: string): string {
  return path.join(homeDir, "sessions.json");
}

function isSessionEncryptionData(value: unknown): value is SessionEncryptionData {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.encryptionKey === "string" &&
    typeof c.seq === "number" &&
    typeof c.metadataVersion === "number" &&
    typeof c.agentStateVersion === "number"
  );
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.sessionId !== "string") return false;
  if (typeof c.savedAt !== "number") return false;
  if (c.provider !== undefined && !PROVIDER_IDS.includes(c.provider as ProviderId)) {
    return false;
  }
  if (c.directory !== undefined && typeof c.directory !== "string") return false;
  if (c.pid !== undefined && typeof c.pid !== "number") return false;
  return isSessionEncryptionData(c.encryption);
}

/**
 * Reads every not-yet-expired, well-formed session record. A missing or
 * corrupt file — or one with a well-formed-JSON-but-wrong-shape entry —
 * resolves to `{}` (that entry silently dropped) rather than throwing: this
 * file is a resume *convenience*, never load-bearing enough to crash daemon
 * boot over (same "no state == no trust" stance as `state.ts`).
 */
export async function readPersistedSessions(
  homeDir: string,
  now: () => number = Date.now,
): Promise<Record<string, PersistedSession>> {
  try {
    const raw = await readFile(sessionsFilePath(homeDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const sessions = (parsed as Partial<SessionsFileShape>).sessions;
    if (typeof sessions !== "object" || sessions === null) return {};

    const cutoff = now() - MAX_SESSION_AGE_MS;
    const result: Record<string, PersistedSession> = {};
    for (const [id, value] of Object.entries(sessions)) {
      if (isPersistedSession(value) && value.savedAt >= cutoff) {
        result[id] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// One write-chain per homeDir, so `persistSession`/`removePersistedSession`
// calls overlapping in time (but for different homeDirs, e.g. across tests)
// never block each other, while calls for the *same* homeDir always
// serialize through the same read-modify-write critical section.
const writeChains = new Map<string, Promise<void>>();

function serialize<T>(homeDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(homeDir) ?? Promise.resolve();
  const settleResult = previous.then(fn, fn);
  writeChains.set(
    homeDir,
    settleResult.then(
      () => undefined,
      () => undefined,
    ),
  );
  return settleResult;
}

async function writeSessionsFile(
  homeDir: string,
  sessions: Record<string, PersistedSession>,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  const file = sessionsFilePath(homeDir);
  const tmpFile = `${file}.tmp`;
  const payload: SessionsFileShape = { schemaVersion: SESSIONS_SCHEMA_VERSION, sessions };
  await writeFile(tmpFile, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpFile, file); // atomic on POSIX
}

/**
 * Upserts one session's durable record (design: "wrapped DEK + seq +
 * versions"). Read-modify-write against the *current* on-disk contents —
 * not a caller-held snapshot — so a `persistSession` for session A never
 * clobbers a concurrent `persistSession` for session B.
 */
export async function persistSession(homeDir: string, session: PersistedSession): Promise<void> {
  await serialize(homeDir, async () => {
    const existing = await readPersistedSessions(homeDir);
    existing[session.sessionId] = session;
    await writeSessionsFile(homeDir, existing);
  });
}

/**
 * Removes one session's durable record — e.g. once `resumeSession` has
 * successfully relaunched it and a fresh `/session-started` webhook has
 * superseded the old record. A no-op if the id isn't present (including if
 * the whole file is missing), matching every other "safe to call more than
 * once" cleanup helper in this package.
 */
export async function removePersistedSession(homeDir: string, sessionId: string): Promise<void> {
  await serialize(homeDir, async () => {
    const existing = await readPersistedSessions(homeDir);
    if (!(sessionId in existing)) return;
    delete existing[sessionId];
    await writeSessionsFile(homeDir, existing);
  });
}

/** Deletes `sessions.json` outright. Used by `kvy doctor clean`/tests; a no-op if it doesn't exist. */
export async function clearPersistedSessions(homeDir: string): Promise<void> {
  await serialize(homeDir, async () => {
    await unlink(sessionsFilePath(homeDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  });
}
