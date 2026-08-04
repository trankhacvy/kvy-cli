/**
 * "SDK stream → `SDKToEnvelope` converter → ordered outgoing queue (strict
 * incremental order; tool-start release may be delayed until stable)").
 *
 * incremental-id ordering, with `tool-start` envelopes held back briefly so
 * a same-turn `tool-end` can catch up and release them together instead of
 * flashing a "running" card that a slow client barely has time to render.
 *
 *  - The "what to delay" and "what releases it" decisions are derived
 *    directly from the envelope's own `ev.t`/`ev.call` fields instead of a
 *    caller-supplied `{delay, toolCallIds}` options bag — every `tool-start`
 *    is delayed by construction, keyed by its own `call` id, and any
 *    `tool-end` sharing that `call` id releases it immediately.
 *  - No `AsyncLock` — a single-threaded Node event loop never actually
 *    `queueMicrotask` batching (rather than `setTimeout(…, 0)`) is enough to
 *    coalesce a burst of synchronous `push()` calls into one drain pass.
 */
import type { SessionEnvelope } from "@kvy/wire";

/** Tool-start release delay (250ms) — long enough for a same-turn tool-end to catch up before releasing. */
export const DEFAULT_TOOL_START_DELAY_MS = 250;

interface QueueItem {
  readonly id: number;
  readonly envelope: SessionEnvelope;
  released: boolean;
  readonly releaseKey?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface OrderedEnvelopeQueueOptions {
  /** Called once per envelope, strictly in push order, once it's released. */
  onFlush: (envelope: SessionEnvelope) => void;
  /** Delay before an unreleased `tool-start` auto-releases. Default 250ms. */
  toolStartDelayMs?: number;
}

/**
 * FIFO envelope queue: entries drain in the order they were pushed, but a
 * `tool-start` entry blocks everything pushed after it from draining until
 * it is released (by its matching `tool-end` arriving, or the delay timer
 * firing) — "strict incremental order" per the design quote above.
 */
export class OrderedEnvelopeQueue {
  private queue: QueueItem[] = [];
  private nextId = 1;
  private readonly toolStartDelayMs: number;
  private readonly onFlush: (envelope: SessionEnvelope) => void;
  private drainScheduled = false;
  private disposed = false;

  constructor(options: OrderedEnvelopeQueueOptions) {
    this.onFlush = options.onFlush;
    this.toolStartDelayMs = options.toolStartDelayMs ?? DEFAULT_TOOL_START_DELAY_MS;
  }

  /** Enqueue one envelope, strictly after everything already pushed. */
  push(envelope: SessionEnvelope): void {
    if (this.disposed) return;
    const ev = envelope.ev;
    const isToolStart = ev.t === "tool-start";
    const item: QueueItem = {
      id: this.nextId++,
      envelope,
      released: !isToolStart,
      releaseKey: isToolStart ? ev.call : undefined,
    };

    if (ev.t === "tool-start") {
      item.timer = setTimeout(() => this.release(item), this.toolStartDelayMs);
    }
    this.queue.push(item);

    if (ev.t === "tool-end") {
      const pendingStart = this.queue.find((i) => i.releaseKey === ev.call && !i.released);
      if (pendingStart) this.release(pendingStart);
    }

    this.scheduleDrain();
  }

  /** Convenience for `converter.convert(...)`'s array results — preserves relative order. */
  pushAll(envelopes: readonly SessionEnvelope[]): void {
    for (const envelope of envelopes) this.push(envelope);
  }

  private release(item: QueueItem): void {
    if (item.released) return;
    item.released = true;
    if (item.timer) {
      clearTimeout(item.timer);
      item.timer = undefined;
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head?.released) break;
      this.queue.shift();
      this.onFlush(head.envelope);
    }
  }

  /** Force-releases and drains everything immediately (session teardown). */
  flush(): void {
    for (const item of this.queue) {
      if (item.timer) {
        clearTimeout(item.timer);
        item.timer = undefined;
      }
      item.released = true;
    }
    this.drain();
  }

  /** Stops all pending timers without draining — nothing further will flush. */
  dispose(): void {
    this.disposed = true;
    for (const item of this.queue) {
      if (item.timer) clearTimeout(item.timer);
    }
    this.queue = [];
  }
}
