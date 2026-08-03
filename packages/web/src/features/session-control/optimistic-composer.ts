import { createEnvelope, type SessionEnvelope } from "@kvy/wire";
import { type FileItem, type RenderItem, stableSortByTime, type TextItem } from "@/sync/reducer";
import type { MessageRpcResult } from "@/sync/sessionRpc";

/**
 * A composer message sent but not yet confirmed by the canonical transcript.
 * `queued` is true while the session process is still finishing a prior
 * turn, so the composer can show "queued" rather than implying the agent is
 * already reading it. `reconcileByStatus` below only ever updates `queued` —
 * it doesn't change how or whether a pending entry is rendered, only
 * whether/when it's dropped.
 *
 * A discriminated union (not just text) since the composer's attach-file
 * path optimistically inserts a `FileItem`-shaped pending entry the same
 * way a text send inserts a `TextItem`-shaped one.
 */
export type PendingMessage =
  | { kind: "text"; localId: string; text: string; sentAt: number; queued: boolean }
  | {
      kind: "file";
      localId: string;
      name: string;
      size: number;
      sentAt: number;
      queued: boolean;
    };

/**
 * Builds the envelope sent over the `message` RPC (`{envelope: SessionEnvelope}`).
 * The envelope's `id` — cuid2, minted here, not server-assigned — doubles as
 * the reconciliation key: the session process is expected to carry it
 * through unchanged into the canonical transcript, the same way the CLI's
 * own tailer preserves an envelope's id from capture to broadcast. If a
 * future change alters that assumption, `reconcilePending`'s id-match below
 * is the only line that needs updating.
 */
export function buildMessageEnvelope(text: string, now: number = Date.now()): SessionEnvelope {
  return createEnvelope("user", { t: "text", md: text }, { time: now });
}

/**
 * Mints the envelope an already-uploaded attachment becomes — `ref` is the
 * blob-storage `blobId` (`lib/blobs.ts`'s `uploadAttachment`), same
 * id-doubles-as-reconciliation-key contract as `buildMessageEnvelope`.
 * `opts.id`, when given, lets the caller mint the optimistic pending
 * entry's id *before* the (async, upload-then-envelope) send completes and
 * have the final envelope carry that same id — otherwise a fresh cuid2 id
 * minted only after the upload finishes wouldn't match whatever id the
 * pending UI entry was tracked under while the upload was in flight.
 */
export function buildFileEnvelope(
  file: { ref: string; name: string; size: number },
  opts: { time?: number; id?: string } = {},
): SessionEnvelope {
  return createEnvelope(
    "user",
    { t: "file", ref: file.ref, name: file.name, size: file.size },
    { time: opts.time ?? Date.now(), id: opts.id },
  );
}

/**
 * Whether some turn has closed at or after `sentAt` — the self-healing
 * fallback `reconcilePending` uses for a still-`queued` entry that neither
 * id nor text matching below has confirmed yet (fixes the stale "Queued"
 * banner + duplicate message bubble). Per the
 * CLI's transcript mapper (`envelopeMapper.ts`'s `closeTurn`), a turn only
 * ever closes when a *new* user message lands in the transcript — so a
 * `turn-end` at/after the moment a message was queued is proof some user
 * prompt has already been injected and the transcript has moved on past it.
 * Given the injection controller flushes queued web messages strictly
 * idle-gated and one at a time, that prompt is, in the ordinary single-actor
 * case this indicator exists for, the queued message itself.
 */
function hasTurnClosedSince(items: RenderItem[], sentAt: number): boolean {
  return items.some((item) => item.kind === "turn-end" && item.time >= sentAt);
}

/** Drops any pending message that has already landed in `items` (matched by
 * `RenderItem.id === localId`) — the reconciliation half of "optimistic
 * insert, reconciled by echo update". Falls back to matching by exact
 * `(role: user, text)` content when the id doesn't match — a defense-in-depth
 * fallback (an implementation that injects web text straight into the same
 * PTY the local process reads from has no id-threading step to drop in the
 * first place; but Kvy's
 * dual local/remote-mode design has several hops — RPC handler, local
 * pub-sub, the mode loop, the SDK wrapper — any one of which silently
 * dropping the id would otherwise leave a permanent duplicate on screen
 * rather than a self-healing one). Each landed text item can satisfy at most
 * one pending entry, claimed in send order, so two genuinely distinct
 * pending sends with identical text don't both collapse onto one echo.
 *
 * A further, last-resort fallback (`hasTurnClosedSince` above) covers a
 * still-`queued` entry that even the two matching passes above never
 * confirm — e.g. an id AND content mismatch (a CLI-side reformat, a dropped
 * id, or the entry simply being far enough behind other reconciled sends
 * that its own echo is ambiguous). Restricted to `queued` entries only
 * (never a send that was never queued in the first place, which has no
 * "behind a turn" story to self-heal from) so it can't mask a genuinely
 * still-in-flight, never-queued send.
 *
 * Returns the same array reference when nothing changed, so callers can skip
 * a re-render via referential equality. */
export function reconcilePending(pending: PendingMessage[], items: RenderItem[]): PendingMessage[] {
  if (pending.length === 0) return pending;
  const landedIds = new Set(items.map((item) => item.id));
  const landedUserTexts = items.filter(
    (item): item is TextItem => item.role === "user" && item.kind === "text",
  );
  const claimed = new Set<string>();

  const next = pending.filter((p) => {
    if (landedIds.has(p.localId)) return false;
    if (p.kind === "text") {
      const match = landedUserTexts.find((item) => !claimed.has(item.id) && item.md === p.text);
      if (match) {
        claimed.add(match.id);
        return false;
      }
    }
    if (p.queued && hasTurnClosedSince(items, p.sentAt)) return false;
    return true;
  });

  return next.length === pending.length ? pending : next;
}

/** Renders a still-pending message/attachment as the `TextItem`/`FileItem`
 * it will become once the real echo lands — same shape the corresponding
 * envelope reduces to, so it slots into the timeline indistinguishably
 * except for whatever "sending…"/"queued" chrome the caller layers on top. */
export function pendingToRenderItem(pending: PendingMessage): TextItem | FileItem {
  const base = { id: pending.localId, time: pending.sentAt, role: "user" as const };
  if (pending.kind === "file") {
    return { ...base, kind: "file", ref: pending.localId, name: pending.name, size: pending.size };
  }
  return { ...base, kind: "text", md: pending.text, thinking: false };
}

/**
 * Merges still-optimistic `pending` sends into the confirmed `items` in
 * chronological order, instead of blindly appending them at the end. A
 * naive concatenation puts every pending entry after every confirmed item
 * regardless of `time` — harmless while nothing else is happening, but
 * wrong the moment a pending send is `queued` behind a busy turn: the
 * resulting tool-call envelopes (e.g. an `AskUserQuestion` card) can sync in
 * and land in `items` before this composer's own pending-message echo
 * reconciles, rendering the *result* of a message above the message that
 * caused it. `stableSortByTime` (the reducer's own ordering rule) fixes the
 * visual order without changing reconciliation timing — a pending entry
 * still only disappears once `reconcilePending` drops it.
 */
export function mergeRenderItems(items: RenderItem[], pending: PendingMessage[]): RenderItem[] {
  if (pending.length === 0) return items;
  return stableSortByTime([...items, ...pending.map(pendingToRenderItem)]);
}

/**
 * Reconciles the pending entry for `localId` against the tri-state
 * `message` RPC reply (`queued | duplicate | outcome-unknown`). Called
 * instead of a bare `queued`-flag update once a `sendMessage` call resolves.
 *
 * - `status: 'queued'`, or no `status` at all (every producer before the
 *   claim store landed only ever sets `queued`): unchanged behavior — the
 *   pending entry's `queued` flag tracks whether the agent is still
 *   finishing a prior turn.
 * - `status: 'duplicate'`: a claim for this envelope id already recorded a
 *   terminal result, so this call is a replay of an already-delivered send.
 *   Reconciled as success by dropping the pending entry immediately — no
 *   *new* optimistic entry is ever created here (this function only ever
 *   updates the existing one a caller already pushed).
 * - `status: 'outcome-unknown'`: a claim exists with no recorded result
 *   (crash mid-turn). The pending entry is left exactly as-is — it still
 *   reconciles the normal way via `reconcilePending` once/if the real echo
 *   lands in the transcript. Callers MUST NOT treat this as a cue to
 *   resend under a fresh envelope id; `deliveryNotice` below is the only
 *   thing this outcome should trigger.
 */
export function reconcileByStatus(
  pending: PendingMessage[],
  localId: string,
  result: MessageRpcResult,
): PendingMessage[] {
  if (result.status === "duplicate") {
    return pending.filter((p) => p.localId !== localId);
  }
  if (result.status === "outcome-unknown") {
    return pending;
  }
  return pending.map((p) => (p.localId === localId ? { ...p, queued: result.queued } : p));
}

/**
 * User-facing notice for an `outcome-unknown` send result (the "reconcile
 * from the transcript, surface a non-blocking notice" contract). `null` for
 * every other reply — including the legacy `status`-less shape, which
 * carries no uncertainty to report.
 */
export function deliveryNotice(result: MessageRpcResult): string | null {
  if (result.status !== "outcome-unknown") return null;
  return "Couldn't confirm this message was delivered. Reconciling from the transcript.";
}

const RELAY_UNREACHABLE_ERRORS = new Set(["RPC target not available", "RPC target disconnected"]);

/**
 * The composer never blocks on
 * `machineOffline`, but a genuinely failed send should read like a machine
 * problem, not a raw transport string. `rpcHandler.ts` produces exactly
 * these two literal messages for "the daemon isn't in this RPC target's
 * room" — translated regardless of what `machineOffline` currently says,
 * because the relay's own failure is authoritative about reachability even
 * when client-side presence still thinks the machine is online (stale
 * `lastSeenAt`, clock skew, or a presence event that hasn't arrived yet).
 * Every other error passes through unchanged.
 */
export function translateSendError(raw: string, _machineOffline: boolean): string {
  if (RELAY_UNREACHABLE_ERRORS.has(raw)) {
    return "That machine is offline right now.";
  }
  return raw;
}
