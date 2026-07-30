import type { PermissionMode } from "@falcon/wire";
import type { SetModeResult } from "@/sync/sessionRpc";

/** "Take control" is only meaningful for a genuine remote-loop session — a
 * PTY/terminal session's `takeControl` RPC handler is a permanent,
 * always-`{ok:true}` no-op ("the human is already at this terminal"), so
 * callers hide the action entirely for `controlMode === "local"`. */
export function shouldShowTakeControl(controlMode: "local" | "remote"): boolean {
  return controlMode === "remote";
}

/**
 * Whether the mode selector's `setMode` mutation is real (`true`) or should
 * degrade to a read-only display (`false`). A remote-loop session's
 * `setMode` is unconditionally real; a PTY/local session's is real only once
 * the flag-gated Shift+Tab cycle (plan-v2.md W4.3) has been enabled on this
 * build (`ptySetModeEnabled`, defaulted to `false`).
 */
export function canMutateMode(controlMode: "local" | "remote", ptySetModeEnabled = false): boolean {
  return controlMode === "remote" || (controlMode === "local" && ptySetModeEnabled);
}

/**
 * `ControlBar`'s reaction to a settled `setMode` mutation (plan-v2.md W4.3
 * "Real setMode for the PTY path"). Kept as a pure module — same precedent
 * as `stop-session-state.ts` — so the `{ok:false}` revert branch (verification
 * timeout, or the PTY injection gate closed — both expected outcomes per the
 * design, not edge cases) is directly testable (`ControlBar.test.ts`)
 * without mounting the component (this package has no RTL/jsdom test setup
 * — see `vitest.config.ts`).
 */
export interface ModeSwitchOutcome {
  /** What `selectedMode` should become. */
  mode: PermissionMode;
  /** Error text to surface next to the selector, or `null` to clear it. */
  error: string | null;
}

/**
 * `target` is the mode optimistically selected before the RPC settled;
 * `previous` is the mode that was confirmed beforehand (the fallback revert
 * target when the RPC didn't report an `observedMode`). A resolved
 * `{ok:false}` is not an exception — it's an honest "didn't happen" — so the
 * selector must revert to whatever mode the RPC actually observed
 * (`result.observedMode`) rather than keep showing the unconfirmed `target`.
 */
export function nextModeAfterSetMode(
  target: PermissionMode,
  previous: PermissionMode,
  result: SetModeResult,
): ModeSwitchOutcome {
  if (result.ok) return { mode: target, error: null };
  return {
    mode: result.observedMode ?? previous,
    error: "Could not confirm the mode switch. Reverted.",
  };
}
