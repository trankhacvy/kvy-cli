/**
 * Kept separate from `outbox.ts` so the crash-recovery/cap-eviction logic is
 * testable without spinning up a whole Outbox instance.
 *
 * Layout: one JSONL file per session at `<homeDir>/outbox/<sessionId>.jsonl`,
 * one `QueuedBatch` per line, oldest first.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EncryptedBox } from "@kvy/wire";
import type { Logger } from "../logger.js";

/** One sealed batch waiting to be POSTed. */
export interface QueuedBatch {
  localId: string;
  content: EncryptedBox;
  /** Serialized byte size of `{localId, content}` — used for 10MB cap accounting. */
  bytes: number;
}

export const DEFAULT_MAX_QUEUE_BYTES = 10 * 1024 * 1024;

function payloadBytes(localId: string, content: EncryptedBox): number {
  return Buffer.byteLength(JSON.stringify({ localId, content }));
}

export function makeQueuedBatch(localId: string, content: EncryptedBox): QueuedBatch {
  return { localId, content, bytes: payloadBytes(localId, content) };
}

/** Where a session's pending outbox batches live on disk. */
export function outboxQueuePath(homeDir: string, sessionId: string): string {
  return path.join(homeDir, "outbox", `${sessionId}.jsonl`);
}

function isQueuedBatch(value: unknown): value is QueuedBatch {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueuedBatch>;
  return (
    typeof candidate.localId === "string" &&
    typeof candidate.bytes === "number" &&
    !!candidate.content &&
    typeof candidate.content === "object"
  );
}

/**
 * A corrupt line is skipped with a warning rather than aborting the whole
 * load — one bad line cannot sink the rest of the backlog.
 */
export function loadQueue(filePath: string, logger: Logger): QueuedBatch[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return []; // no queue file yet — nothing to recover
  }

  const entries: QueuedBatch[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isQueuedBatch(parsed)) {
        entries.push(parsed);
      } else {
        logger.warn("outbox: skipping malformed queue entry on disk", { filePath });
      }
    } catch {
      logger.warn("outbox: skipping unparsable queue line on disk", { filePath });
    }
  }
  return entries;
}

/**
 * Rewrites the whole queue file atomically (write to a temp file, then
 * rename over it) so a crash mid-write never leaves a half-written, corrupt
 * queue file behind. An empty queue removes the file entirely.
 */
export function persistQueue(filePath: string, entries: readonly QueuedBatch[]): void {
  if (entries.length === 0) {
    rmSync(filePath, { force: true });
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  renameSync(tmpPath, filePath);
}

/**
 * Appends `entry`, then evicts from the front (oldest first) until the queue
 * fits `maxBytes`. Bounds disk usage during an extended server outage — the
 * newest entry is always kept even if it alone exceeds the cap, since the cap
 * is a backpressure valve on old backlog, not a license to drop live data.
 */
export function appendWithCap(
  entries: readonly QueuedBatch[],
  entry: QueuedBatch,
  maxBytes: number,
  logger: Logger,
): QueuedBatch[] {
  const updated = [...entries, entry];
  let total = updated.reduce((sum, e) => sum + e.bytes, 0);
  let droppedBatches = 0;

  while (total > maxBytes && updated.length > 1) {
    const dropped = updated.shift();
    if (!dropped) break;
    total -= dropped.bytes;
    droppedBatches += 1;
  }

  if (droppedBatches > 0) {
    logger.warn("outbox: disk queue exceeded 10MB cap, dropped oldest batch(es)", {
      droppedBatches,
      totalBytes: total,
      maxBytes,
    });
  }

  return updated;
}
