import type { AttentionKind } from "@/features/session-list/types";
import type { RenderItem } from "@/sync/reducer";

/**
 * states are derived, never stored: a session needs attention iff
 * (pending permission ∨ pending question ∨ completed-and-unseen)").
 * Priority order when more than one would apply, highest first: a pending
 * permission blocks the agent outright, so it always wins; a `failed` turn
 * is actionable until a new turn starts, so it outranks a clean completion.
 * `null` means nothing is outstanding.
 */
export type AttentionState = "perm" | "question" | "failed" | "done" | null;

/** Recursively checks this item and any nested subagent items for a
 * permission that was requested but has no decision yet. Ported from
 * `features/session-list/status.ts`'s `hasPendingPermission` (same shared
 * reference semantics: `permission` is mutated in place by the reducer when
 * a `perm-resolve` lands, so an undefined `decision` always means "still
 * outstanding right now") — duplicated rather than imported to keep this
 * module's only dependency on `features/session-list` the `AttentionKind`
 * type, not its internals. */
function hasPendingPermission(items: RenderItem[]): boolean {
  for (const item of items) {
    if (item.kind === "perm-placeholder" && item.permission.decision === undefined) return true;
    if (item.kind === "tool") {
      if (item.permission && item.permission.decision === undefined) return true;
      if (item.subagent && hasPendingPermission(item.subagent)) return true;
    }
    if (item.kind === "subagent-group" && hasPendingPermission(item.items)) return true;
  }
  return false;
}

/** The most recently closed top-level turn's status and end time, or `null`
 * if there hasn't been one yet (matches `status.ts`'s turn-scoping: subagent
 * turns are scoped to their parent tool call, not walked here). */
function lastClosedTurn(
  items: RenderItem[],
): { status: "completed" | "failed" | "cancelled"; time: number } | null {
  let last: { status: "completed" | "failed" | "cancelled"; time: number } | null = null;
  for (const item of items) {
    if (item.kind === "turn-end") last = { status: item.status, time: item.time };
  }
  return last;
}

export interface DeriveAttentionInput {
  items: RenderItem[];
  /** The server's `attention` ephemeral for this session, or `null` — the
   * only source for "question" (the wire's `SessionEvent` union has no
   * "agent asked a question" variant yet). Droppable/coalesced per design
   * (both of those are re-derivable from `items` alone even if the
   * ephemeral was missed). */
  ephemeralAttentionKind: AttentionKind | null;
  /** This device's last-seen timestamp for the session (`last-seen.ts`), or
   * `null` if it's never been viewed here. */
  lastSeenAt: number | null;
}

export function deriveAttention(input: DeriveAttentionInput): AttentionState {
  const { items, ephemeralAttentionKind, lastSeenAt } = input;

  if (hasPendingPermission(items)) return "perm";
  if (ephemeralAttentionKind === "question") return "question";

  const closed = lastClosedTurn(items);
  if (closed?.status === "failed" || ephemeralAttentionKind === "failed") return "failed";
  if (closed?.status === "completed" && closed.time > (lastSeenAt ?? Number.NEGATIVE_INFINITY)) {
    return "done";
  }

  return null;
}

export interface AttentionMeta {
  label: string;
  /** Single-character glyph for a favicon/title prefix — cheap, high-value
  glyph: string;
  /** Tailwind color token for a favicon dot, matching `SESSION_STATUS_META`'s
   * palette (`features/session-list/status.ts`) so the same state reads the
   * same color everywhere. */
  color: string;
}

export const ATTENTION_META: Record<Exclude<AttentionState, null>, AttentionMeta> = {
  perm: { label: "Needs permission", glyph: "●", color: "#f59e0b" },
  question: { label: "Needs input", glyph: "●", color: "#f59e0b" },
  failed: { label: "Failed", glyph: "●", color: "#ef4444" },
  done: { label: "Completed", glyph: "✓", color: "#10b981" },
};
