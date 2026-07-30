import type { SetModelResult } from "@/sync/sessionRpc";

/**
 * Whether the model selector's `setModel` mutation is real (`true`) or
 * should degrade to the existing read-only chip (`false`) — docs/known-
 * issues.md issue #12 "web model selector". Unlike `canMutateMode`, this is
 * never true for `controlMode === "remote"`: `setModel` is only implemented
 * on the terminal-attached PTY flow (`start.ts`'s `runLocalPty`) — the
 * headless ACP remote-loop flow has no live TUI to type `/model` into and
 * always answers `{ok:false}` (`runRemoteLoop`'s handler). Flag-gated the
 * same way `setMode`'s PTY path is (`ptySetModelEnabled`, defaulted to
 * `false`) until it's been live-soaked.
 */
export function canMutateModel(
  controlMode: "local" | "remote",
  ptySetModelEnabled = false,
): boolean {
  return controlMode === "local" && ptySetModelEnabled;
}

/**
 * `ComposerControls`' reaction to a settled `setModel` mutation. Pure
 * module, same precedent as `mode-switch-state.ts`'s `nextModeAfterSetMode`
 * — directly testable without mounting the component.
 *
 * Unlike `nextModeAfterSetMode`, a failed switch always reverts to
 * `previous` rather than `result.observedModel`: `observedMode` is a closed
 * `PermissionMode` enum value, safe to feed straight back into that
 * selector, but `observedModel` is Claude Code's own free-text display name
 * parsed from the transcript (e.g. "Sonnet 5" for a requested "sonnet") —
 * not one of the curated alias values this selector's options use, so it
 * can't be fed back in as a selection.
 */
export interface ModelSwitchOutcome {
  /** Error text to surface next to the selector, or `null` to clear it. */
  error: string | null;
}

export function nextModelAfterSetModel(result: SetModelResult): ModelSwitchOutcome {
  if (result.ok) return { error: null };
  return { error: "Could not confirm the model switch. Reverted." };
}
