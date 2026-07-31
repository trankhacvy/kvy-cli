"use client";

import type { SessionRow } from "@falcon/wire";
import { useState } from "react";
import { useSessionCrypto } from "@/features/session-control/use-session-crypto";
import {
  canOfferRemoveWorktree,
  isSessionStoppable,
} from "@/features/session-list/components/session-card-actions-logic";
import { apiSocket, createSessionRpcClient } from "@/sync";
import {
  type ArchiveSessionState,
  initialArchiveSessionState,
  toArchiveError,
  toArchiving,
  toChecking,
  toStateAfterWorktreeRemove,
  toStopping,
} from "./archive-session-state";
import { useRemoveWorktree } from "./use-remove-worktree";
import { useArchiveSessionMutation } from "./use-session-lifecycle";

export interface UseArchiveSessionResult {
  state: ArchiveSessionState;
  /** True while crypto this run still needs (session-scoped for the stop
   * call, machine-scoped for the worktree removal) is still unwrapping —
   * the caller should disable its confirm button until this clears. */
  pending: boolean;
  /** Starts the whole sequence: stop the live process (if any) → remove the
   * worktree (dirty-confirm included) → mark archived. The caller's own
   * confirm dialog calls this once, from its initial "Archive" button —
   * nothing happens on mount. */
  runArchive: () => void;
  /** Discards the worktree's uncommitted/untracked changes and archives —
   * the caller's escalation path once `state.phase` is `"confirm-force"`. */
  confirmForceArchive: () => void;
}

/**
 * Drives the single Archive action end to end (Home's `SessionCardActions`
 * and the timeline header's `SessionActionsMenu` share this one flow via
 * `ArchiveSessionDialog`): stop the CLI process if it's still live, then —
 * for a worktree-mode session — remove its `.worktrees/<branch>` directory
 * (a clean worktree needs no further confirm; a dirty one stops at
 * `"confirm-force"` rather than silently discarding uncommitted/untracked
 * work), then mark the session archived. A session with no worktree
 * (`workspaceId: null`) just stops and archives. Only mount this hook while
 * the dialog is actually open — a screen full of session cards never spins
 * up one crypto worker per row — it unwraps a session-scoped crypto worker
 * (for `stop`) and, when there's a worktree, a machine-scoped one too (for
 * `worktree.remove`).
 */
export function useArchiveSession(options: {
  sessionId: string;
  status: SessionRow["status"];
  machineId: string | null;
  workspaceId: string | null;
  onArchived: () => void;
}): UseArchiveSessionResult {
  const { sessionId, status, machineId, workspaceId, onArchived } = options;
  const [state, setState] = useState<ArchiveSessionState>(initialArchiveSessionState);
  const archiveMutation = useArchiveSessionMutation();
  const sessionCrypto = useSessionCrypto(sessionId);
  const canRemoveWorktree = canOfferRemoveWorktree(machineId, workspaceId);
  const { pending: worktreeCryptoPending, removeWorktree } = useRemoveWorktree(
    machineId ?? "",
    workspaceId ?? "",
  );
  const stoppable = isSessionStoppable(status);
  const pending =
    (stoppable && sessionCrypto === null) || (canRemoveWorktree && worktreeCryptoPending);

  function handleError(error: unknown) {
    setState(toArchiveError(error));
  }

  function finishArchive() {
    setState(toArchiving());
    archiveMutation.mutate(sessionId, {
      onSuccess: onArchived,
      onError: handleError,
    });
  }

  function removeWorktreeThenArchive(removeOptions: { force?: boolean } = {}) {
    if (!canRemoveWorktree) {
      finishArchive();
      return;
    }
    removeWorktree(removeOptions).then((result) => {
      const next = toStateAfterWorktreeRemove(result);
      setState(next);
      if (next.phase === "archiving") finishArchive();
    }, handleError);
  }

  function runArchive() {
    if (!stoppable) {
      setState(toChecking());
      removeWorktreeThenArchive();
      return;
    }
    setState(toStopping());
    if (!sessionCrypto) {
      handleError(new Error("Crypto bridge isn't ready yet. Try again in a moment."));
      return;
    }
    createSessionRpcClient({ socket: apiSocket, crypto: sessionCrypto, sessionId })
      .call("stop", {})
      .then(() => {
        setState(toChecking());
        removeWorktreeThenArchive();
      }, handleError);
  }

  function confirmForceArchive() {
    removeWorktreeThenArchive({ force: true });
  }

  return { state, pending, runArchive, confirmForceArchive };
}
