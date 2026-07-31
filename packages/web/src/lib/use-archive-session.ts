"use client";

import { useEffect, useState } from "react";
import {
  type ArchiveSessionState,
  initialArchiveSessionState,
  toArchiveError,
  toArchiving,
  toStateAfterWorktreeRemove,
} from "./archive-session-state";
import { useRemoveWorktree } from "./use-remove-worktree";
import { useArchiveSessionMutation } from "./use-session-lifecycle";

export interface UseArchiveSessionResult {
  state: ArchiveSessionState;
  /** Discards the worktree's uncommitted/untracked changes and archives — the caller's escalation path once `state.phase` is `"confirm-force"`. */
  confirmForceArchive: () => void;
}

/**
 * Drives one worktree-mode session's Archive action end to end: removes its
 * `.worktrees/<branch>` directory first (a clean worktree needs no confirm
 * at all), then archives the session once the worktree is gone. A dirty
 * worktree stops at `"confirm-force"` instead of silently discarding
 * uncommitted/untracked work — `confirmForceArchive` is the caller's
 * explicit escalation, same shape as `RemoveWorktreeDialog`'s own
 * confirm-force step. Only mount this hook once the user has actually
 * triggered Archive (same "crypto/RPC machinery only mounts while active"
 * discipline `RemoveWorktreeDialog` follows) — it unwraps a machine crypto
 * key via `useRemoveWorktree`, which spins up its own worker.
 */
export function useArchiveSession(options: {
  sessionId: string;
  machineId: string;
  workspaceId: string;
  onArchived: () => void;
}): UseArchiveSessionResult {
  const { sessionId, machineId, workspaceId, onArchived } = options;
  const [state, setState] = useState<ArchiveSessionState>(initialArchiveSessionState);
  const [started, setStarted] = useState(false);
  const archiveMutation = useArchiveSessionMutation();
  const { pending, removeWorktree } = useRemoveWorktree(machineId, workspaceId);

  function handleError(error: unknown) {
    setState(toArchiveError(error));
  }

  function finishArchive() {
    archiveMutation.mutate(sessionId, {
      onSuccess: onArchived,
      onError: handleError,
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts exactly once, the first time the machine crypto key is ready — `started` guards against a second attempt on a later `pending` flip.
  useEffect(() => {
    if (pending || started) return;
    setStarted(true);
    removeWorktree({}).then((result) => {
      const next = toStateAfterWorktreeRemove(result);
      setState(next);
      if (next.phase === "archiving") finishArchive();
    }, handleError);
  }, [pending, started]);

  function confirmForceArchive() {
    setState(toArchiving());
    removeWorktree({ force: true }).then(finishArchive, handleError);
  }

  return { state, confirmForceArchive };
}
