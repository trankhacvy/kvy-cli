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
