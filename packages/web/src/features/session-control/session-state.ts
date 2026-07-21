import type { PermissionMode } from "@falcon/wire";
import type { RenderItem } from "@/sync/reducer";

/**
 * The session's current local/remote control mode (falcon-system-design.md
 * §7.5's mode state machine), read straight off the most recent
 * `mode-switch` item — `"local"` if none has happened yet (sessions start
 * local unless spawned with `--starting-mode remote`). Drives whether
 * `ControlBar` offers "Take control" at all (design §4.4: `takeControl`
 * "triggers local→remote switch" — nothing to take if it's already remote).
 */
export function deriveControlMode(items: RenderItem[]): "local" | "remote" {
  let control: "local" | "remote" = "local";
  for (const item of items) {
    if (item.kind === "mode-switch") control = item.control;
  }
  return control;
}

/** Whether the session's most recent top-level turn is still open — a
 * `turn-start` with no later `turn-end`. Ported from
 * `features/session-list/status.ts`'s `isTurnOpen` (duplicated, not
 * imported, for the same reason `attention.ts`'s `hasPendingPermission` is:
 * this module's only dependency should be the `RenderItem` type itself).
 * Used as a fallback "working" signal alongside the live `activity`
 * ephemeral (design §4.3's ephemerals are droppable/coalesced — a missed
 * one shouldn't disable Interrupt on an actually-open turn). */
export function isTurnOpen(items: RenderItem[]): boolean {
  let open = false;
  for (const item of items) {
    if (item.kind === "turn-start") open = true;
    else if (item.kind === "turn-end") open = false;
  }
  return open;
}

/**
 * The session-detail header's "Working…" signal (`SessionTimelineScreen.tsx`,
 * docs/user-flows.md fix-plan item 2). `isTurnOpen(items)` — always freshly
 * re-derived from the persisted, canonical event stream — is authoritative:
 * once it says `false`, `working` is `false`, full stop, regardless of what
 * the live `activity` ephemeral (`use-session-ephemerals.ts`) claims.
 *
 * The previous `ephemeralWorking || isTurnOpen(items)` computation let a
 * *droppable* ephemeral permanently mask a correct, closed `isTurnOpen`
 * signal — its `working:false` companion never arriving (or a stray
 * `working:true` re-arriving) pinned the header on "Working…" for up to
 * `WORKING_STALE_MS` (60s) at best, forever at worst. `isTurnOpen` alone
 * can't have that failure mode: it's recomputed from `items` on every call,
 * never a stored flag that can go stale (design principle #3) — exactly how
 * `features/session-list/status.ts`'s equivalent already behaves, confirmed
 * live to never get stuck. (In practice today nothing on the CLI side ever
 * emits the `activity` ephemeral `ephemeralWorking` is fed by, so this
 * doesn't even change observed behavior yet — it closes the hole before a
 * future CLI-side emitter can fall into it.)
 *
 * `ephemeralWorking` is kept as a bounded early-paint hint for the one
 * window `isTurnOpen` genuinely can't help with: before this session has
 * *any* turn history at all (a brand-new session, or one whose first page
 * hasn't loaded yet), where `isTurnOpen([])` is unconditionally `false`. Once
 * a single `turn-start`/`turn-end` has ever landed, that hint is retired for
 * good — it can never re-assert `working` after a real turn-end has closed
 * the turn, satisfying the hard requirement above unconditionally.
 */
export function deriveWorking(items: RenderItem[], ephemeralWorking: boolean): boolean {
  if (isTurnOpen(items)) return true;
  const hasTurnHistory = items.some(
    (item) => item.kind === "turn-start" || item.kind === "turn-end",
  );
  return !hasTurnHistory && ephemeralWorking;
}

/**
 * The session's current permission mode (falcon-system-design.md §7.5,
 * plan-v2.md W2.4), replacing `SessionTimelineScreen`'s previously-hardcoded
 * `"default"` passed to `ControlBar`. There is no wire event carrying a bare
 * "the mode is now X" fact — `mode-switch` items only carry *control*
 * (`"local"` | `"remote"`, see `deriveControlMode` above), never a
 * `PermissionMode` value. The one place a `PermissionMode` value actually
 * appears is a `perm-resolve` decision of kind `"mode"` (a `PermCard`
 * "Approve & <mode>" / "Switch to <mode>" answer, W2.2/W2.4), which the
 * reducer applies onto whichever item's `PermissionInfo` it belongs to
 * (`perm-placeholder` or `tool`) — so this walks the same two item kinds
 * `hasPendingPermission` (`attention.ts`) does, last-one-wins in item order.
 * A `mode-switch` item resets the running value back to `"default"`:
 * crossing a local/remote control boundary makes the previously-known mode
 * stale — the newly-controlling side's actual mode is unknown until its own
 * decision lands. Defaults to `"default"` (Claude Code's own starting mode)
 * when nothing has happened yet.
 */
export function deriveCurrentPermissionMode(items: RenderItem[]): PermissionMode {
  let mode: PermissionMode = "default";
  for (const item of items) {
    if (item.kind === "mode-switch") {
      mode = "default";
    } else if (item.kind === "perm-placeholder" && item.permission.decision?.kind === "mode") {
      mode = item.permission.decision.mode;
    } else if (item.kind === "tool" && item.permission?.decision?.kind === "mode") {
      mode = item.permission.decision.mode;
    }
  }
  return mode;
}
