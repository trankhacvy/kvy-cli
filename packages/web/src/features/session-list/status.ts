import type { RenderItem } from "@/sync/reducer";
import type { AttentionKind, SessionListSession } from "./types";
import type { MachineStatus } from "./use-machine-presence";

/**
 * The Home screen's per-session status dot (falcon-prd.md FR-7.1,
 * falcon-system-design.md §9.2 "Home" row). Design principle #3: this is
 * *computed*, every call, from the session's reduced event stream plus live
 * presence/attention signals — never a stored flag that can go stale.
 */
export type SessionListStatus =
  | "working"
  | "waiting-for-permission"
  | "waiting-for-input"
  | "ready"
  | "idle"
  | "completed"
  | "ended"
  | "failed"
  | "offline";

export interface DeriveSessionStatusInput {
  status: SessionListSession["status"];
  /** `null` when the session isn't tied to a machine (no presence to check). */
  machineOnline: boolean | null;
  /** `null` means this session's message page hasn't decrypted yet — see
   * `SessionListSession.items`'s own doc comment. Treated as "unknown, not
   * yet zero" so it degrades to `"idle"`, never a fabricated `"ready"`. */
  items: RenderItem[] | null;
  attention: AttentionKind | null;
}

/** Recursively checks this item and any nested subagent items for a
 * permission that was requested but has no decision yet — `permission` is
 * shared by reference and updated in place when a `perm-resolve` lands
 * (see `RenderItem`'s doc comment), so an undefined `decision` always means
 * "still outstanding right now", not "as of some stale snapshot". Subagent
 * content can reach this list two ways (`reduceEnvelopes`'s
 * `linkSubagentScopes`): linked onto the parent `ToolItem.subagent`, or, for
 * a scope that never matched a parent tool call, as a standalone top-level
 * `subagent-group` item — both are walked so an orphaned subagent's pending
 * permission still surfaces instead of being silently missed. */
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

/** Whether the session's most recent turn is still open — a `turn-start`
 * with no later `turn-end` in the top-level item list. Subagent turns are
 * scoped to their parent tool call, not the session as a whole, so only the
 * top-level stream is walked here. */
function isTurnOpen(items: RenderItem[]): boolean {
  let open = false;
  for (const item of items) {
    if (item.kind === "turn-start") open = true;
    else if (item.kind === "turn-end") open = false;
  }
  return open;
}

/** The `status` of the most recently closed turn, or `null` if the session
 * has never had one (no turns yet, or the only turn(s) are still open). */
function lastClosedTurnStatus(items: RenderItem[]): "completed" | "failed" | "cancelled" | null {
  let status: "completed" | "failed" | "cancelled" | null = null;
  for (const item of items) {
    if (item.kind === "turn-end") status = item.status;
  }
  return status;
}

/** Whether `items` contains a `turn-start` ANYWHERE in the session's history
 * — distinct from `isTurnOpen`, which only tracks the *most recent* turn.
 * A session that's had three turns and gone quiet has `isTurnOpen() ===
 * false` but must still read as `"idle"`, not `"ready"`: only a session
 * that has never once started a turn (`items: []`, or an items list that's
 * simply never seen a `turn-start`) qualifies as brand-new. */
function hasEverHadTurn(items: RenderItem[]): boolean {
  return items.some((item) => item.kind === "turn-start");
}

/**
 * Derives the Home-screen status for one session. Priority (highest first):
 * terminal session row state → offline → pending permission → pending
 * question → actively working → last-turn outcome → ready/idle.
 *
 * `"ready"` vs `"idle"` (docs/known-issues.md #9): both are "nothing is
 * currently happening", but they mean different things to a user glancing at
 * Home. A session with zero turns ever (`hasEverHadTurn(items) === false`) is
 * a freshly started, healthy session that just hasn't been given a first
 * message yet — `"ready"`. A session with real turn history that's simply
 * quiet between turns is `"idle"`. Checked last, after `isTurnOpen` and the
 * last-turn-outcome checks, so an open or just-finished turn always takes
 * priority over "brand new" even on a session's very first turn.
 *
 * `items === null` (this session's message page hasn't decrypted/been
 * fetched yet — `SessionListSession.items`'s doc comment) is deliberately
 * NOT treated as "zero turns": every other check above runs against an
 * empty stand-in so none of them fire, and the function falls through to
 * `"idle"`, not `"ready"` — the safe, pre-existing default while the real
 * answer is still unknown. Reporting "ready" here would flash a fabricated
 * "brand new" badge on every session, with real history or not, for the
 * span of its own decrypt — the same conflation known-issues.md #9 was
 * filed to fix, just relocated rather than removed.
 *
 * `"ended"` (plan-v2.md W1.4+B15) is its own terminal row state, distinct
 * from `"completed"`: `completed` describes a *turn* outcome (or an
 * archived/compacted row) on a session that's still otherwise controllable,
 * while `ended` means the underlying CLI process itself is gone — the PTY
 * path's normal/signal exit (`start.ts`'s `reportStatusOnce`). Checked
 * before `archived`/`compacted` since those two never apply to a live PTY
 * session in the first place, but ordering doesn't actually matter given
 * they're mutually exclusive DB values.
 *
 * Turn state (open/closed, closed-turn outcome, pending permission) is
 * replayed straight from `items` — the reduced event stream, design
 * principle #3. `attention` fills the one gap `items` can't: "question" (the
 * wire's `SessionEvent` union has no "agent asked a question" variant yet)
 * and "the last turn finished but nobody has looked" (`"done"`), which turns
 * an otherwise-idle closed turn into a `completed` badge until viewed
 * (falcon-prd.md FR-8.1 "completed-and-unseen"). A turn that closed with
 * `status: "failed"` is always shown as `failed`, seen or not — unlike a
 * clean completion, an error is actionable until the user starts a new turn.
 */
export function deriveSessionStatus(input: DeriveSessionStatusInput): SessionListStatus {
  const { status, machineOnline, items, attention } = input;
  // `items === null` (not yet decrypted) runs every check below against an
  // empty stand-in — none of them can legitimately fire without real data —
  // so it always falls through to the `items === null` branch at the end.
  const knownItems = items ?? [];

  if (status === "failed") return "failed";
  if (status === "ended") return "ended";
  if (status === "archived" || status === "compacted") return "completed";
  if (machineOnline === false) return "offline";

  if (hasPendingPermission(knownItems)) return "waiting-for-permission";
  if (attention === "question") return "waiting-for-input";
  if (isTurnOpen(knownItems)) return "working";

  const lastTurn = lastClosedTurnStatus(knownItems);
  if (lastTurn === "failed" || attention === "failed") return "failed";
  if (attention === "done") return "completed";
  if (items === null) return "idle";
  if (!hasEverHadTurn(items)) return "ready";
  return "idle";
}

export interface SessionStatusMeta {
  label: string;
  /** Tailwind class for the status dot's fill color. */
  dotClassName: string;
  /** Whether the dot should carry a "live" pulse animation. */
  pulse: boolean;
}

export const SESSION_STATUS_META: Record<SessionListStatus, SessionStatusMeta> = {
  working: { label: "Working", dotClassName: "bg-blue-500", pulse: true },
  "waiting-for-permission": {
    label: "Needs permission",
    dotClassName: "bg-amber-500",
    pulse: true,
  },
  "waiting-for-input": { label: "Needs input", dotClassName: "bg-amber-500", pulse: true },
  // A brand-new session with no turns yet — deliberately a calmer, "alive"
  // color distinct from both the muted `idle` grey (which would read as
  // "possibly abandoned" on a session that was just created) and the amber
  // "needs attention" family used by the two waiting-* states above.
  ready: { label: "Ready", dotClassName: "bg-sky-500", pulse: false },
  idle: { label: "Idle", dotClassName: "bg-muted-foreground/50", pulse: false },
  completed: { label: "Completed", dotClassName: "bg-emerald-500", pulse: false },
  ended: { label: "Ended", dotClassName: "bg-slate-500", pulse: false },
  failed: { label: "Failed", dotClassName: "bg-destructive", pulse: false },
  offline: { label: "Offline", dotClassName: "bg-muted-foreground/30", pulse: false },
};

/**
 * The Home screen's machine badge status (AH8 "machine-status-reauth",
 * docs/auth-ux-hardening-plan.md item 8) — a distinct third state alongside
 * `online`/`offline` (`MachineBadge`'s own component, not `SessionCard`'s
 * per-session dot above): a daemon that's running but can't authenticate
 * (refresh token revoked) needs `falcon auth login`, not "wake the machine",
 * so it gets its own amber "Needs re-authentication" chip rather than
 * collapsing into the same grey "Offline" a genuinely powered-off machine
 * shows.
 */
export const MACHINE_STATUS_META: Record<MachineStatus, SessionStatusMeta> = {
  online: { label: "Online", dotClassName: "bg-emerald-500", pulse: false },
  offline: { label: "Offline", dotClassName: "bg-muted-foreground/40", pulse: false },
  "needs-reauth": { label: "Needs re-authentication", dotClassName: "bg-amber-500", pulse: false },
};
