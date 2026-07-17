import { createEnvelope, type SessionEnvelope } from "@falcon/wire";
import type { FileItem, RenderItem, TextItem } from "@/sync/reducer";

/**
 * A composer message sent but not yet confirmed by the canonical transcript
 * (falcon-system-design.md §9.1: "optimistic timeline insert reconciled by
 * echo update"; plan.md §16 "2.4 Web control surface"). `queued` mirrors the
 * `message` RPC's own result (design §4.4: `{queued: boolean}`) — true while
 * the session process is still finishing a turn, so the composer can show
 * "queued" rather than implying the agent is already reading it.
 *
 * A discriminated union (not just text) since the composer's attach-file
 * path (plan.md §16 "4.3 Distribution & self-host": "encrypted attachment
 * path in the web composer") optimistically inserts a `FileItem`-shaped
 * pending entry the same way a text send inserts a `TextItem`-shaped one.
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
 * Mints the envelope a composer text send becomes (design §4.4 `message`
 * RPC: `{envelope: SessionEnvelope}`). The envelope's `id` — cuid2, minted
 * here, not server-assigned — doubles as the reconciliation key: the
 * session process is expected to carry it through unchanged into the
 * canonical transcript, the same way the CLI's own tailer preserves an
 * envelope's id from capture to broadcast. If a future landing changes that
 * assumption, `reconcilePending`'s id-match below is the only line that
 * needs updating.
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

/** Drops any pending message that has already landed in `items` (matched by
 * `RenderItem.id === localId`) — the reconciliation half of "optimistic
 * insert, reconciled by echo update". Falls back to matching by exact
 * `(role: user, text)` content when the id doesn't match — a defense-in-depth
 * borrowed from Omnara's `web_ui_messages` content-set (their CLI wrapper
 * has no id-threading step to drop in the first place, since it injects web
 * text straight into the same PTY the local process reads from; Falcon's
 * dual local/remote-mode design has several hops — RPC handler, local
 * pub-sub, the mode loop, the SDK wrapper — any one of which silently
 * dropping the id would otherwise leave a permanent duplicate on screen
 * rather than a self-healing one). Each landed text item can satisfy at most
 * one pending entry, claimed in send order, so two genuinely distinct
 * pending sends with identical text don't both collapse onto one echo.
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
    if (p.kind !== "text") return true; // fallback only applies to text sends — attachments always carry a real blob ref
    const match = landedUserTexts.find((item) => !claimed.has(item.id) && item.md === p.text);
    if (!match) return true;
    claimed.add(match.id);
    return false;
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
