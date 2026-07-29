"use client";

import { useCallback, useRef, useState } from "react";
import { runSpawnFlow, useLiveNewSessionActions } from "../new-session";
import { translateSpawnError } from "./inline-spawn";
import { buildReviewSpawnRequest } from "./review-spawn";

/**
 * Spawn wiring for the "Review" action (session-panel-workflow-plan.md
 * Phase 3) — mirrors `use-inline-spawn.ts`'s shape closely (same
 * generation-guard-against-stale-response precedent, same "approval branch
 * should be structurally unreachable" reasoning: `repoRoot` is derived from
 * the CURRENT session's own already-registered `workspaceId`, so it's
 * already a known workspace by construction). Simpler surface than
 * `InlineSpawnState` — no in-progress elapsed-seconds UI, just enough to
 * disable the trigger and show an error.
 */
export type ReviewSpawnState =
  | { phase: "idle" }
  | { phase: "spawning" }
  | { phase: "error"; message: string };

export interface ReviewSpawnController {
  state: ReviewSpawnState;
  start: (workspacePath: string, codingBranch: string) => void;
  reset: () => void;
}

export function useReviewSpawn(
  machineId: string,
  onSpawned: (sessionId: string) => void,
): ReviewSpawnController {
  const actions = useLiveNewSessionActions(machineId);
  const [state, setState] = useState<ReviewSpawnState>({ phase: "idle" });
  const generation = useRef(0);

  const start = useCallback(
    (workspacePath: string, codingBranch: string) => {
      const request = buildReviewSpawnRequest(workspacePath, codingBranch);
      if (!request) {
        setState({
          phase: "error",
          message: "This session isn't in an isolated worktree — nothing to review from.",
        });
        return;
      }

      const myGeneration = ++generation.current;
      setState({ phase: "spawning" });

      runSpawnFlow(actions, request, async (approvalDirectory, action) => {
        console.error(
          "features/session-list/use-review-spawn: spawn requested an approval branch that should be structurally unreachable for an already-registered repo root",
          { directory: approvalDirectory, action },
        );
        return false;
      })
        .then((result) => {
          if (generation.current !== myGeneration) return;
          if (result.outcome === "spawned") {
            setState({ phase: "idle" });
            onSpawned(result.sessionId);
            return;
          }
          setState({
            phase: "error",
            message: "Could not start the review session — try again in a moment.",
          });
        })
        .catch((err: unknown) => {
          if (generation.current !== myGeneration) return;
          const raw = err instanceof Error ? err.message : String(err);
          setState({ phase: "error", message: translateSpawnError(raw) });
        });
    },
    [actions, onSpawned],
  );

  const reset = useCallback(() => {
    generation.current++;
    setState({ phase: "idle" });
  }, []);

  return { state, start, reset };
}
