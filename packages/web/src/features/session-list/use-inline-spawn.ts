"use client";

import { useCallback, useRef, useState } from "react";
import { runSpawnFlow, useLiveNewSessionActions } from "../new-session";
import { buildInlineSpawnRequest, type InlineSpawnForm, translateSpawnError } from "./inline-spawn";

/**
 * Spawn wiring for the workspace-row `+` inline creation panel (B3, B4 —
 * new-session-from-web redesign, see the task's own header comment). Reuses
 * the existing `spawn` RPC contract and `features/new-session`'s
 * `useLiveNewSessionActions`/`runSpawnFlow` as-is, exactly as the spec
 * requires — no forked spawn logic.
 *
 * **B3's dead-branch verification.** `runSpawnFlow`'s `confirmApproval`
 * callback exists to resolve `spawn`'s two approval loops
 * (`spawn-flow.ts`'s own doc comment): `"create-directory"` (the target
 * directory doesn't exist — `workspacePath.ts`'s `"not-found"` validation
 * reason) and `"register-workspace"` (the workspace id is unregistered —
 * `"unknown-workspace"`). Both preconditions require BOTH of: (a) the
 * workspace registered from a terminal (`kvy workspace register`/an
 * implicit register on first `kvy` run there — `workspace/registry.ts`)
 * and (b) its directory still existing on disk. This panel only ever
 * renders for a workspace group that has at least one real session that
 * already ran there (`features/session-list/group.ts`'s own grouping
 * precondition — a `WorkspaceGroup` is built FROM already-synced sessions),
 * which is only possible if a prior `spawn` already passed
 * `validateSpawnWorkspace` for that exact `workspaceId`/directory pair. So
 * under normal operation, neither approval branch is reachable here — read
 * `spawnEngine.ts`'s `spawnSession` and `workspacePath.ts`'s
 * `validateSpawnWorkspace` yourself to confirm before trusting this comment.
 *
 * That said, "registered once" is not "still registered/still on disk right
 * now" — a user could `kvy workspace unregister` it or delete the
 * directory out from under a live account between that prior session and
 * this `+` click. Rather than either (a) silently building the old wizard's
 * full approval-confirm UI back in for a case that should never happen, or
 * (b) hanging forever on an unresolved promise, this declines the approval
 * immediately AND logs loudly — surfacing an honest, specific error instead
 * of a generic one, since hitting this branch at all means a structural
 * assumption this whole feature depends on broke.
 */

export type InlineSpawnState =
  | { phase: "idle" }
  | { phase: "spawning"; startedAt: number }
  | { phase: "success"; sessionId: string }
  | { phase: "error"; message: string };

export interface InlineSpawnController {
  state: InlineSpawnState;
  start: (directory: string, form: InlineSpawnForm) => void;
  reset: () => void;
}

export function useInlineSpawn(machineId: string): InlineSpawnController {
  const actions = useLiveNewSessionActions(machineId);
  const [state, setState] = useState<InlineSpawnState>({ phase: "idle" });
  // Guards against a stale async response landing after `reset()`/a second
  // `start()` call — mirrors this codebase's other cancellable-effect
  // precedent (`ImportStep`'s own `cancelled` flag).
  const generation = useRef(0);

  const start = useCallback(
    (directory: string, form: InlineSpawnForm) => {
      const myGeneration = ++generation.current;
      setState({ phase: "spawning", startedAt: Date.now() });

      const request = buildInlineSpawnRequest(directory, form);
      runSpawnFlow(actions, request, async (approvalDirectory, action) => {
        console.error(
          "features/session-list/use-inline-spawn: spawn requested an approval branch that should be structurally unreachable for an already-registered workspace — the workspace was likely unregistered or its directory removed since its last session ran",
          { directory: approvalDirectory, action },
        );
        return false;
      })
        .then((result) => {
          if (generation.current !== myGeneration) return;
          if (result.outcome === "spawned") {
            setState({ phase: "success", sessionId: result.sessionId });
            return;
          }
          // `outcome === "declined"` only ever happens via the logged-loudly
          // branch above now — surface it as an honest error, not a silent
          // return to idle (the old wizard's shape for a *user*-declined
          // approval, which no longer applies here).
          setState({
            phase: "error",
            message:
              "This workspace couldn't be confirmed on that machine. It may have been removed or its folder deleted. Try running kvy there again.",
          });
        })
        .catch((err: unknown) => {
          if (generation.current !== myGeneration) return;
          const raw = err instanceof Error ? err.message : String(err);
          setState({ phase: "error", message: translateSpawnError(raw) });
        });
    },
    [actions],
  );

  const reset = useCallback(() => {
    generation.current++;
    setState({ phase: "idle" });
  }, []);

  return { state, start, reset };
}
