/**
 * The HTTP outbox: coalesce transcript envelopes into batches, seal each
 * batch into one `EncryptedBox`, and POST it to `/v1/sessions/:id/messages`
 * (plan.md §6.5, design §4.3/§11, ⚠ DELTA D1 — new code, no Happy
 * equivalent since Happy ships this over a WS `message` emit instead).
 *
 * Two thresholds decide when a buffered batch of envelopes gets sealed and
 * queued, whichever comes first:
 *   - `maxBatchSize` envelopes have accumulated (default 20), or
 *   - `flushMs` have elapsed since the first envelope in the batch (default 300ms).
 *
 * Once sealed, a batch is appended to a disk-backed queue (10MB cap, oldest
 * evicted first — see `queue.ts`) *before* the network call is attempted, so
 * a batch that's been accepted into the outbox survives a CLI crash or
 * restart even if it was never POSTed. A per-session `Outbox` replays
 * whatever the disk queue holds on construction, so a crash mid-retry picks
 * back up exactly where it left off.
 *
 * Sending is a strict FIFO drain of the disk queue: one batch in flight at a
 * time, retried with backoff *forever* on any non-2xx response or network
 * error ("blind retry until 2xx") — never given up on, because the batch's
 * cuid2 `localId` makes the server-side POST idempotent (a duplicate retry
 * after a successful-but-unacked request just replays the same `seq`). Only
 * a 2xx response dequeues the batch.
 */
import { seal } from "@falcon/crypto";
import type { SessionEnvelope } from "@falcon/wire";
import { createId } from "@paralleldrive/cuid2";
import type { Logger } from "../logger.js";
import type { OutboxHttpClient } from "./httpClient.js";
import {
  appendWithCap,
  DEFAULT_MAX_QUEUE_BYTES,
  loadQueue,
  makeQueuedBatch,
  outboxQueuePath,
  persistQueue,
  type QueuedBatch,
} from "./queue.js";

/** plan.md §6.5: "flush ≤300ms/≤20 into one outbox entry". */
export const DEFAULT_FLUSH_MS = 300;
export const DEFAULT_MAX_BATCH_SIZE = 20;

export interface OutboxOptions {
  sessionId: string;
  /** Data-encryption key this session's batches are sealed under. */
  dek: Uint8Array;
  http: OutboxHttpClient;
  /** `~/.falcon` (or `FALCON_HOME_DIR`) — the disk queue lives under `<homeDir>/outbox/`. */
  homeDir: string;
  logger: Logger;
  /** Coalescing time threshold in ms. Default 300 (plan.md §6.5). */
  flushMs?: number;
  /** Coalescing count threshold. Default 20 (plan.md §6.5). */
  maxBatchSize?: number;
  /** Disk queue cap in bytes. Default 10MB (design §11). */
  maxQueueBytes?: number;
  /** Delay before retry attempt `n` (1-indexed). Default: exponential 1s, capped at 30s. */
  backoffMs?: (attempt: number) => number;
}

function defaultBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Outbox {
  private readonly sessionId: string;
  private readonly dek: Uint8Array;
  private readonly http: OutboxHttpClient;
  private readonly logger: Logger;
  private readonly queuePath: string;
  private readonly flushMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueBytes: number;
  private readonly backoffMs: (attempt: number) => number;

  /** Envelopes buffered since the last flush — not yet sealed or persisted. */
  private buf: SessionEnvelope[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Sealed batches, oldest first — this array mirrors the on-disk queue file exactly. */
  private queue: QueuedBatch[];
  private draining = false;
  private disposed = false;

  constructor(options: OutboxOptions) {
    this.sessionId = options.sessionId;
    this.dek = options.dek;
    this.http = options.http;
    this.logger = options.logger;
    this.queuePath = outboxQueuePath(options.homeDir, options.sessionId);
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;

    // Crash/restart recovery: whatever a previous process left queued gets
    // replayed immediately, before any new envelope is ever enqueued.
    this.queue = loadQueue(this.queuePath, this.logger);
    if (this.queue.length > 0) void this.drain();
  }

  /** Buffers `events`; flushes immediately at the count threshold, else arms the time threshold. */
  enqueue(events: readonly SessionEnvelope[]): void {
    if (this.disposed || events.length === 0) return;
    this.buf.push(...events);
    if (this.buf.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  /** Seals whatever's buffered into one batch, queues it to disk, and kicks off sending. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buf.length === 0) return;

    const batch = this.buf.splice(0, this.buf.length);
    const localId = createId();
    const content = seal(batch, this.dek);
    const queued = makeQueuedBatch(localId, content);

    // Persist BEFORE attempting the network call — the durability guarantee
    // is "queued means it survives a crash", not "sent means it survives".
    this.queue = appendWithCap(this.queue, queued, this.maxQueueBytes, this.logger);
    persistQueue(this.queuePath, this.queue);

    void this.drain();
  }

  /** Buffered-but-unsealed envelope count (test/introspection helper). */
  get bufferedCount(): number {
    return this.buf.length;
  }

  /** Sealed-but-unacked batch count still sitting in the disk queue. */
  get queuedBatchCount(): number {
    return this.queue.length;
  }

  /**
   * Stops the pending flush timer and any retry loop. Does not drop queued/buffered
   * data: any envelopes still sitting unsealed in `buf` are flushed (sealed + persisted
   * to disk) first, so a graceful dispose() never silently drops messages the way a
   * hard crash would — only the disk queue, not the retry loop, is guaranteed to survive.
   */
  dispose(): void {
    if (this.buf.length > 0) this.flush();
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Strict FIFO drain: one batch in flight at a time, dequeued only once it's acked. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.queue.length > 0) {
        const next = this.queue[0];
        if (!next) break;
        const acked = await this.sendUntil2xx(next);
        if (!acked) break; // disposed mid-retry — leave it queued for the next drain
        this.queue = this.queue.slice(1);
        persistQueue(this.queuePath, this.queue);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Blind retry until 2xx: every non-2xx status and every thrown error backs off and retries. */
  private async sendUntil2xx(batch: QueuedBatch): Promise<boolean> {
    let attempt = 0;
    for (;;) {
      if (this.disposed) return false;
      attempt += 1;
      try {
        const result = await this.http.postMessages(this.sessionId, {
          localId: batch.localId,
          content: batch.content,
        });
        if (result.ok) return true;
        this.logger.warn("outbox: non-2xx response, retrying", {
          sessionId: this.sessionId,
          localId: batch.localId,
          status: result.status,
          attempt,
        });
      } catch (error) {
        this.logger.warn("outbox: request failed, retrying", {
          sessionId: this.sessionId,
          localId: batch.localId,
          error: String(error),
          attempt,
        });
      }
      await sleep(this.backoffMs(attempt));
    }
  }
}
