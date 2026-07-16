import type { RenderItem } from "@/sync/reducer";
import type { AttentionKind, SessionListSession } from "./types";

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
  | "idle"
  | "completed"
  | "failed"
  | "offline";

export interface DeriveSessionStatusInput {
  status: SessionListSession["status"];
  /** `null` when the session isn't tied to a machine (no presence to check). */
  machineOnline: boolean | null;
  items: RenderItem[];
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

/**
 * Derives the Home-screen status for one session. Priority (highest first):
 * terminal session row state → offline → pending permission → pending
 * question → actively working → last-turn outcome → idle.
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

  if (status === "failed") return "failed";
  if (status === "archived" || status === "compacted") return "completed";
  if (machineOnline === false) return "offline";

  if (hasPendingPermission(items)) return "waiting-for-permission";
  if (attention === "question") return "waiting-for-input";
  if (isTurnOpen(items)) return "working";

  const lastTurn = lastClosedTurnStatus(items);
  if (lastTurn === "failed" || attention === "failed") return "failed";
  if (attention === "done") return "completed";
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
  idle: { label: "Idle", dotClassName: "bg-muted-foreground/50", pulse: false },
  completed: { label: "Completed", dotClassName: "bg-emerald-500", pulse: false },
  failed: { label: "Failed", dotClassName: "bg-destructive", pulse: false },
  offline: { label: "Offline", dotClassName: "bg-muted-foreground/30", pulse: false },
};
