import type { PermDecision } from "@kvy/wire";

/**
 * `PermCard`'s local phase machine, kept as a pure function so the "first
 * without mounting the component. This is *optimistic* state only — once
 * the canonical `perm-resolve` envelope reaches the reducer, the item's own
 * `permission.decision` prop becomes authoritative and the card renders that
 * instead (see PermCard.tsx), regardless of what phase this machine is in.
 */
export type PermCardPhase =
  | { kind: "idle" }
  | { kind: "submitting"; decision: PermDecision }
  /** Our decision won the first-wins race — shown until the canonical
   * `permission.decision` prop catches up. */
  | { kind: "answered"; decision: PermDecision }
   * device" case. `decision` is the winning one, so the UI can show what
   * actually happened rather than just "you lost". */
  | { kind: "lost-race"; decision: PermDecision }
  /** The click landed on a locally-typed terminal turn's request — there was
   * never a channel for it to do anything (the terminal, not the web, drives
   * the outcome). Distinct from `error`: nothing failed, the click just had
   * no authority. */
  | { kind: "not-answerable" }
  | { kind: "error"; message: string };

/** The shape `SessionRpcClient.call("perm.answer", ...)` resolves to
 * (`@/sync/sessionRpc`'s `PermAnswerResult`) — declared structurally here so
 * this module doesn't need a compile-time dependency on `@/sync`. */
export interface PermAnswerResultLike {
  ok: boolean;
  reason?: "already-answered" | "local-turn";
  decision?: PermDecision;
}

/** Applies a successful RPC round-trip's application-level result (never
 * called for a transport-level failure — that's `fromError` below). */
export function applyAnswerResult(
  submittedDecision: PermDecision,
  result: PermAnswerResultLike,
): PermCardPhase {
  if (result.ok) return { kind: "answered", decision: submittedDecision };
  if (result.reason === "already-answered" && result.decision) {
    return { kind: "lost-race", decision: result.decision };
  }
  if (result.reason === "local-turn") return { kind: "not-answerable" };
  return { kind: "error", message: "The permission request was rejected." };
}

/** Applies a transport-level failure (`SessionRpcError` or any other thrown
 * error from the mutation) — the request never got a real answer either way. */
export function fromError(error: unknown): PermCardPhase {
  const message = error instanceof Error ? error.message : "Could not reach the session.";
  return { kind: "error", message };
}
