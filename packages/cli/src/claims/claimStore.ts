/**
 * Send-idempotency claim store (design §7.10, plan.md §16 "Phase 2.0 —
 * foundation"): claim-before-execute protection for the `message` session
 * RPC, so a retried or duplicated RPC can never cause the agent to run a
 * turn twice for one logical send.
 *
 * Reference semantics adapted (P) from mobvibe's `wal-store.ts`
 * (`claimMessageSend`/`completeMessageSend`,
 * apps/mobvibe-cli/src/wal/wal-store.ts): INSERT-OR-IGNORE the claim, then
 * verify-claimId-then-record-result atomically. mobvibe backs this with a
 * SQLite WAL and a real transaction; Falcon's design instead calls for a
 * plain per-session JSON file (`~/.falcon/claims/<sessionId>.json`, design
 * §7.2/§7.10) under the same O_CREAT|O_EXCL lock-file + tmp-write-then-rename
 * pattern `persistence.ts`/`workspace/registry.ts` already use — so this is
 * a port-with-changes: the tri-state claim semantics are faithful, but the
 * storage engine (and therefore the concurrency primitive — an exclusive
 * file lock instead of a SQL transaction) is not.
 *
 * A pre-existing claim with no recorded result is *indeterminate*: the
 * prior claimant may have crashed mid-turn, and the design is explicit that
 * this must never be silently re-executed. `claimMessageSend` reports that
 * case as `'in-progress'` rather than a fresh `'claimed'` (design §7.10's
 * flow step ①); it is up to the caller (the `message` RPC handler, wired in
 * Phase 2.2's `deliverMessage()` — out of scope here) to reply
 * `'outcome-unknown'` and never blind-resend under a fresh id.
 *
 * This module is standalone and self-contained: nothing in Phase 2.0 wires
 * it into a live RPC handler yet — it is tested in isolation.
 */

import { randomUUID } from "node:crypto";
import { existsSync, constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { resolveHomeDir } from "../home.js";

export interface ClaimStoreOptions {
  /** Overrides the resolved `~/.falcon` (or `FALCON_HOME_DIR`) directory. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock, mirroring `sessionsStore.ts`'s `now` param — tests use this to control retention pruning without real sleeps. */
  now?: () => number;
}

/** A live claim: some process durably claimed this envelope id and has not yet recorded a result. */
export interface PendingClaimEntry {
  status: "claimed";
  claimId: string;
  claimedAt: number;
}

/** A terminal record: the send this envelope id represents has already run to completion. */
export interface CompletedClaimEntry {
  status: "completed";
  result: unknown;
  completedAt: number;
}

export type ClaimEntry = PendingClaimEntry | CompletedClaimEntry;

/** Tri-state claim outcome (design §7.10) — mirrors mobvibe's `claimed`/`completed`/`in_progress`, kebab-cased to match this codebase's other status strings. */
export type ClaimOutcome =
  | { status: "claimed"; claimId: string }
  | { status: "completed"; result: unknown }
  | { status: "in-progress" };

interface ClaimsFileShape {
  schemaVersion: number;
  claims: Record<string, ClaimEntry>;
}

export const CLAIMS_SCHEMA_VERSION = 1;

/**
 * Completed claims older than this are pruned on the next write to this
 * session's claim file (bounded retention, design §7.10). A *pending*
 * (`'claimed'`, no result) entry is never pruned by age — evicting an
 * indeterminate claim would make a later retry look fresh again and
 * silently re-execute it, exactly what this store exists to prevent. Only
 * an explicit `completeMessageSend` (or `clearClaims` deleting the file
 * wholesale, e.g. on session archive) ever removes a pending entry.
 */
const CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function homeDirFrom(options: ClaimStoreOptions): string {
  return options.homeDir ?? resolveHomeDir(options.env ?? process.env);
}

export function claimsFilePath(homeDir: string, sessionId: string): string {
  return path.join(homeDir, "claims", `${sessionId}.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntry(value: unknown): ClaimEntry | null {
  if (!isPlainObject(value)) return null;
  if (value.status === "claimed") {
    if (typeof value.claimId !== "string" || typeof value.claimedAt !== "number") return null;
    return { status: "claimed", claimId: value.claimId, claimedAt: value.claimedAt };
  }
  if (value.status === "completed") {
    if (typeof value.completedAt !== "number" || !("result" in value)) return null;
    return { status: "completed", result: value.result, completedAt: value.completedAt };
  }
  return null;
}

/** Field-by-field extraction, same rationale as `persistence.ts`'s `normalizeSettings`: unknown/malformed entries are dropped, not fatal to the whole read. */
function normalizeClaimsFile(raw: unknown): ClaimsFileShape {
  if (!isPlainObject(raw) || !isPlainObject(raw.claims)) {
    return { schemaVersion: CLAIMS_SCHEMA_VERSION, claims: {} };
  }
  const claims: Record<string, ClaimEntry> = {};
  for (const [envelopeId, value] of Object.entries(raw.claims)) {
    const entry = normalizeEntry(value);
    if (entry) claims[envelopeId] = entry;
  }
  return { schemaVersion: CLAIMS_SCHEMA_VERSION, claims };
}

/** Reads one session's claim file, falling back to an empty store on a missing/corrupt file — never throws. */
async function readClaimsFileRaw(homeDir: string, sessionId: string): Promise<ClaimsFileShape> {
  const file = claimsFilePath(homeDir, sessionId);
  if (!existsSync(file)) return { schemaVersion: CLAIMS_SCHEMA_VERSION, claims: {} };

  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return normalizeClaimsFile(parsed);
  } catch {
    return { schemaVersion: CLAIMS_SCHEMA_VERSION, claims: {} };
  }
}

/**
 * Drops completed entries past the retention window. Pending (`'claimed'`)
 * entries are exempt — see `CLAIM_RETENTION_MS`'s doc comment.
 */
function pruneExpired(file: ClaimsFileShape, now: number): ClaimsFileShape {
  const cutoff = now - CLAIM_RETENTION_MS;
  const claims: Record<string, ClaimEntry> = {};
  for (const [envelopeId, entry] of Object.entries(file.claims)) {
    if (entry.status === "completed" && entry.completedAt < cutoff) continue;
    claims[envelopeId] = entry;
  }
  return { ...file, claims };
}

const LOCK_RETRY_INTERVAL_MS = 100;
const MAX_LOCK_ATTEMPTS = 50; // 5 seconds total
const STALE_LOCK_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires an exclusive lock file via O_CREAT|O_EXCL (atomic create-or-fail),
 * retrying while another process/invocation holds it, and reclaiming it if
 * its mtime is older than `STALE_LOCK_TIMEOUT_MS` (a prior holder that died
 * without cleaning up) — mirrors `persistence.ts`'s `acquireLock` exactly.
 */
async function acquireLock(lockFile: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      return await open(lockFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      await sleep(LOCK_RETRY_INTERVAL_MS);
      try {
        const stats = await stat(lockFile);
        if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
          await unlink(lockFile).catch(() => {});
        }
      } catch {
        // Lock file vanished between the failed open and this stat — another
        // attempt already cleared it; the next loop iteration retries open().
      }
    }
  }
  const timeoutSec = (MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS) / 1000;
  throw new Error(`failed to acquire claim store lock after ${timeoutSec}s: ${lockFile}`);
}

/**
 * Exclusive-lock read-modify-write over one session's claim file. `mutate`
 * runs while the lock is held and returns the next file contents plus
 * whatever value the caller wants back; throwing from `mutate` aborts the
 * write (the lock is still released, but nothing is persisted) — this is
 * how `completeMessageSend` rejects a stale/mismatched claim id without
 * corrupting the file. Holding the lock for the whole
 * read-prune-mutate-write section is what gives `claimMessageSend` its
 * INSERT-OR-IGNORE atomicity: two concurrent claim attempts for the same
 * envelope id serialize through this lock, so exactly one observes "no
 * existing entry" and wins the claim.
 */
async function withClaimsFile<T>(
  homeDir: string,
  sessionId: string,
  options: ClaimStoreOptions,
  mutate: (current: ClaimsFileShape, now: number) => { file: ClaimsFileShape; result: T },
): Promise<T> {
  const file = claimsFilePath(homeDir, sessionId);
  const lockFile = `${file}.lock`;
  const tmpFile = `${file}.tmp`;

  await mkdir(path.dirname(file), { recursive: true });
  const lock = await acquireLock(lockFile);

  try {
    const now = (options.now ?? Date.now)();
    const current = pruneExpired(await readClaimsFileRaw(homeDir, sessionId), now);
    const { file: next, result } = mutate(current, now);
    const withVersion: ClaimsFileShape = { ...next, schemaVersion: CLAIMS_SCHEMA_VERSION };

    await writeFile(tmpFile, JSON.stringify(withVersion, null, 2), "utf8");
    await rename(tmpFile, file); // atomic on POSIX

    return result;
  } finally {
    await lock.close();
    // Best-effort: by this point the write already succeeded (or `mutate`
    // threw past this point already), so a failure to remove the lock file
    // isn't actionable here — the next acquirer's stale-mtime check
    // reclaims it regardless.
    await unlink(lockFile).catch(() => {});
  }
}

/**
 * Claim-before-execute (design §7.10 flow steps ① / ②): look up
 * `envelopeId` in this session's claim store.
 *
 * - No entry yet ⇒ durably write a fresh claim and return `'claimed'`; the
 *   caller now owns executing this send and must eventually call
 *   `completeMessageSend` with the returned `claimId`.
 * - A recorded result ⇒ `'completed'`: this exact send already ran; the
 *   caller should reply `duplicate` and never re-execute.
 * - A live claim with no result ⇒ `'in-progress'`: the outcome is
 *   indeterminate (the original claimant may have crashed mid-turn) and
 *   MUST NOT be treated as safe to (re-)execute.
 */
export async function claimMessageSend(
  sessionId: string,
  envelopeId: string,
  options: ClaimStoreOptions = {},
): Promise<ClaimOutcome> {
  const homeDir = homeDirFrom(options);
  const claimId = randomUUID();
  return withClaimsFile<ClaimOutcome>(homeDir, sessionId, options, (current, now) => {
    const existing = current.claims[envelopeId];
    if (existing?.status === "completed") {
      return { file: current, result: { status: "completed", result: existing.result } };
    }
    if (existing?.status === "claimed") {
      return { file: current, result: { status: "in-progress" } };
    }

    const next: ClaimsFileShape = {
      ...current,
      claims: { ...current.claims, [envelopeId]: { status: "claimed", claimId, claimedAt: now } },
    };
    return { file: next, result: { status: "claimed", claimId } };
  });
}

/**
 * Atomically persist a completed result and clear the pending claim (design
 * §7.10 flow step ③). Verifies `claimId` still matches the active claim
 * before recording anything — mirrors mobvibe's `completeMessageSend`
 * verify-claimId-then-record-result guard — so a stale/superseded claimant
 * can never overwrite a result it doesn't own. Throws if there is no active
 * claim for `envelopeId`, or one exists under a different `claimId`.
 */
export async function completeMessageSend(
  sessionId: string,
  envelopeId: string,
  claimId: string,
  result: unknown,
  options: ClaimStoreOptions = {},
): Promise<void> {
  const homeDir = homeDirFrom(options);
  await withClaimsFile(homeDir, sessionId, options, (current, now) => {
    const existing = current.claims[envelopeId];
    if (existing?.status !== "claimed" || existing.claimId !== claimId) {
      throw new Error(
        `claim store: no active claim ${claimId} for envelope ${envelopeId} in session ${sessionId}`,
      );
    }

    const next: ClaimsFileShape = {
      ...current,
      claims: {
        ...current.claims,
        // `?? null` — JSON.stringify silently drops an `undefined` value,
        // which would make a completed entry round-trip as if it had never
        // been written; storing `null` instead keeps the entry (and thus
        // the duplicate-detection guarantee) intact.
        [envelopeId]: { status: "completed", result: result ?? null, completedAt: now },
      },
    };
    return { file: next, result: undefined };
  });
}

/** Reads every claim entry for a session, applying the same retention prune a write would. Mainly for introspection/tests. */
export async function readClaims(
  sessionId: string,
  options: ClaimStoreOptions = {},
): Promise<Record<string, ClaimEntry>> {
  const homeDir = homeDirFrom(options);
  const now = (options.now ?? Date.now)();
  const file = pruneExpired(await readClaimsFileRaw(homeDir, sessionId), now);
  return file.claims;
}

/** Deletes a session's whole claim file outright — e.g. once a session is archived/deleted. A no-op if it doesn't exist. */
export async function clearClaims(
  sessionId: string,
  options: ClaimStoreOptions = {},
): Promise<void> {
  const homeDir = homeDirFrom(options);
  await unlink(claimsFilePath(homeDir, sessionId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
