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
