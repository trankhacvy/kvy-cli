"use client";

import type { PermissionMode } from "@falcon/wire";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSessionControl } from "@/features/session-control";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
};

/** "Take control" is only shown for a genuine remote-loop session — see the
 * component doc comment. Exported for testing without rendering the full
 * component + its React Query/session-control context (plan-v2.md W2.4). */
export function shouldShowTakeControl(controlMode: "local" | "remote"): boolean {
  return controlMode === "remote";
}

/** Whether the mode selector's `setMode` mutation is real (`true`) or should
 * degrade to a read-only display (`false`) — see the component doc comment.
 * Exported for testing, same reasoning as `shouldShowTakeControl`. */
export function canMutateMode(controlMode: "local" | "remote"): boolean {
  return controlMode === "remote";
}

/**
 * Session control bar (falcon-system-design.md §9.2 "Session" row:
 * `ControlBar` "interrupt, mode selector, take-control"; falcon-prd.md
 * FR-7.3). All three actions call the session RPCs already registered
 * server-side from §2.1/§2.2 (design §4.4): `interrupt`, `setMode`,
 * `takeControl`.
 *
 * `mode`/`controlMode`/`working` are the caller's best current read of
 * session state (derived from the reduced transcript + live ephemerals,
 * design principle #3) — this component only owns the *optimistic* mode
 * selection while a `setMode` call is in flight, rolling back on failure.
 *
 * Two honesty fixes (plan-v2.md W2.4, "ControlBar honesty: real mode, real
 * capabilities"), both keyed off `controlMode`:
 *
 *  - **Take control** is only ever meaningful for a genuine remote-loop
 *    session (`controlMode === "remote"`) — a PTY/terminal session's
 *    `takeControl` RPC handler (`start.ts`'s `runLocalPty`) is a permanent,
 *    always-`{ok:true}` no-op ("the human is already at this terminal —
 *    there is no remote turn to reclaim from"), so the button is hidden
 *    entirely for `controlMode === "local"` rather than offering an action
 *    that can never do anything.
 *  - **setMode** genuinely works for a remote-loop session
 *    (`runRemoteLoop`'s handler calls the live ACP session's `setMode`), but
 *    a PTY session's handler honestly returns `{ok:false}` always ("the
 *    live TUI owns its own permission mode") — until U4.5 wires a real PTY
 *    `setMode`, the selector drops its mutating affordance for
 *    `controlMode === "local"` and becomes a plain read-only display of the
 *    derived mode, rather than surfacing an error after every attempt.
 */
export function ControlBar({
  mode,
  controlMode,
  working,
}: {
  mode: PermissionMode;
  controlMode: "local" | "remote";
  working: boolean;
}) {
  const { actions } = useSessionControl();
  const [selectedMode, setSelectedMode] = useState(mode);
  const [modeError, setModeError] = useState<string | null>(null);

  // The canonical mode can change underneath this component (another device
  // switched it, or a permission answer resolved by mode-switch) — stay in
  // sync whenever it does, rather than freezing on whatever was true at mount.
  useEffect(() => {
    setSelectedMode(mode);
  }, [mode]);

  const interruptMutation = useMutation({ mutationFn: () => actions.interrupt() });
  const takeControlMutation = useMutation({ mutationFn: () => actions.takeControl() });
  const setModeMutation = useMutation({
    mutationFn: (next: PermissionMode) => actions.setMode(next),
  });

  function handleModeChange(next: PermissionMode) {
    const previous = selectedMode;
    setSelectedMode(next);
    setModeError(null);
    setModeMutation.mutate(next, {
      onError: (error) => {
        setSelectedMode(previous);
        setModeError(error instanceof Error ? error.message : "Could not change the mode.");
      },
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-sm">
      <Button
        size="sm"
        variant="destructive"
        disabled={!working || interruptMutation.isPending}
        onClick={() => interruptMutation.mutate()}
      >
        Interrupt
      </Button>

      {canMutateMode(controlMode) ? (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Mode
          <select
            value={selectedMode}
            disabled={setModeMutation.isPending}
            onChange={(e) => handleModeChange(e.target.value as PermissionMode)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Mode: {MODE_LABEL[mode]}
        </span>
      )}

      {shouldShowTakeControl(controlMode) && (
        <Button
          size="sm"
          variant="secondary"
          disabled={takeControlMutation.isPending}
          onClick={() => takeControlMutation.mutate()}
        >
          Take control
        </Button>
      )}

      {modeError && <span className="text-xs text-destructive">{modeError}</span>}
      {interruptMutation.isError && (
        <span className="text-xs text-destructive">Could not interrupt.</span>
      )}
      {takeControlMutation.isError && (
        <span className="text-xs text-destructive">Could not take control.</span>
      )}
    </div>
  );
}
