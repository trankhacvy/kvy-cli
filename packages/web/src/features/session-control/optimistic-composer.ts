import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import type { RenderItem, TextItem } from "@/sync/reducer";

/**
 * A composer message sent but not yet confirmed by the canonical transcript
 * (falcon-system-design.md §9.1: "optimistic timeline insert reconciled by
 * echo update"; plan.md §16 "2.4 Web control surface"). `queued` mirrors the
 * `message` RPC's own result (design §4.4: `{queued: boolean}`) — true while
 * the session process is still finishing a turn, so the composer can show
 * "queued" rather than implying the agent is already reading it.
 */
export interface PendingMessage {
  localId: string;
  text: string;
  sentAt: number;
  queued: boolean;
}

/**
 * Mints the envelope a composer send becomes (design §4.4 `message` RPC:
 * `{envelope: SessionEnvelope}`). The envelope's `id` — cuid2, minted here,
 * not server-assigned — doubles as the reconciliation key: the session
 * process is expected to carry it through unchanged into the canonical
 * transcript, the same way the CLI's own tailer preserves an envelope's id
 * from capture to broadcast. If a future landing changes that assumption,
 * `reconcilePending`'s id-match below is the only line that needs updating.
 */
export function buildMessageEnvelope(text: string, now: number = Date.now()): SessionEnvelope {
  return createEnvelope("user", { t: "text", md: text }, { time: now });
}

/** Drops any pending message that has already landed in `items` (matched by
 * `RenderItem.id === localId`) — the reconciliation half of "optimistic
 * insert, reconciled by echo update". Returns the same array reference when
 * nothing changed, so callers can skip a re-render via referential equality. */
export function reconcilePending(pending: PendingMessage[], items: RenderItem[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const landed = new Set(items.map((item) => item.id));
  const next = pending.filter((p) => !landed.has(p.localId));
  return next.length === pending.length ? pending : next;
}

/** Renders a still-pending message as the `TextItem` it will become once
 * the real echo lands — same shape a `text` envelope from this user reduces
 * to, so it slots into the timeline indistinguishably except for whatever
 * "sending…"/"queued" chrome the caller layers on top. */
export function pendingToRenderItem(pending: PendingMessage): TextItem {
  return {
    id: pending.localId,
    time: pending.sentAt,
    role: "user",
    kind: "text",
    md: pending.text,
    thinking: false,
  };
}
