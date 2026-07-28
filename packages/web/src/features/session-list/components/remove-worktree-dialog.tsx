"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRemoveWorktree } from "@/lib/use-remove-worktree";
import {
  initialRemoveWorktreeDialogState,
  type RemoveWorktreeDialogState,
  toRemoveError,
  toRemoveResultState,
  toRemoving,
  toRemovingForce,
} from "./remove-worktree-dialog-state";

/**
 * "Remove worktree" confirm dialog (Phase C, new-session-from-web redesign —
 * `worktreeRemove.ts`'s own doc comment). Reachable from `SessionCardActions`
 * for a session whose `workspaceId` looks like a `.worktrees/<branch>`
 * directory (`worktree-path.ts`'s `looksLikeWorktreePath`) — every session
 * spawned via the workspace-row `+` flow qualifies, since it always creates
 * a fresh worktree (B3).
 *
 * Root CLAUDE.md's "never put a destructive action next to a safe one, state
 * the consequence" principle shapes this directly: removing the worktree
 * DIRECTORY is the primary, safe(r) action — branch deletion is reversible
 * only by re-creating the branch from memory/reflog, so it's a separate
 * checkbox, unchecked by default, with its own explicit warning copy, never
 * silently implied by "Remove worktree" alone. A worktree with uncommitted
 * or untracked changes doesn't get silently force-removed OR silently
 * fail — the RPC reports `requiresForce`, and this escalates to a SECOND,
 * more explicit confirm step before ever discarding that work.
 *
 * Same "crypto/RPC machinery only mounts while open" discipline as
 * `RestartSessionDialog` — a Home screen full of worktree-mode sessions
 * never spins up one machine-crypto worker per row.
 */
export function RemoveWorktreeDialog({
  machineId,
  worktree,
  sessionTitle,
  open,
  onOpenChange,
}: {
  machineId: string;
  /** The exact worktree directory to remove — a worktree-mode session's own `workspaceId`. */
  worktree: string;
  sessionTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this worktree?</DialogTitle>
          <DialogDescription>
            Deletes the on-disk worktree directory for "{sessionTitle}". The session's transcript
            and history in Falcon are unaffected — this only cleans up the machine's checkout.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <RemoveWorktreeBody
            machineId={machineId}
            worktree={worktree}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveWorktreeBody({
  machineId,
  worktree,
  onDone,
}: {
  machineId: string;
  worktree: string;
  onDone: () => void;
}) {
  const { pending, removeWorktree } = useRemoveWorktree(machineId, worktree);
  const [state, setState] = useState<RemoveWorktreeDialogState>(initialRemoveWorktreeDialogState);
  // Separate, off-by-default opt-in — never bundled into the safe primary
  // action (root CLAUDE.md's destructive-action principle).
  const [deleteBranch, setDeleteBranch] = useState(false);

  function handleRemove() {
    setState(toRemoving());
    removeWorktree({ deleteBranch }).then(
      (result) => setState(toRemoveResultState(result)),
      (err) => setState(toRemoveError(err)),
    );
  }

  function handleForceRemove() {
    setState(toRemovingForce());
    removeWorktree({ force: true, deleteBranch }).then(
      (result) => setState(toRemoveResultState(result)),
      (err) => setState(toRemoveError(err)),
    );
  }

  if (state.phase === "done") {
    return (
      <>
        <p className="text-sm text-muted-foreground">
          Worktree removed.
          {deleteBranch &&
            (state.branchDeleted
              ? " The branch was also deleted."
              : " The branch could not be deleted — you may need to remove it manually.")}
        </p>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  if (state.phase === "confirm-force") {
    return (
      <>
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <Badge variant="warning">Needs attention</Badge>
          <p className="text-muted-foreground">
            This worktree has uncommitted or untracked changes. Removing it now will discard them
            permanently.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleForceRemove}>
            Discard changes and remove
          </Button>
        </DialogFooter>
      </>
    );
  }

  const removing = state.phase === "removing" || state.phase === "removing-force";

  return (
    <>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={deleteBranch}
          onChange={(e) => setDeleteBranch(e.target.checked)}
        />
        <span className="flex flex-col">
          <span className="font-medium text-amber-600 dark:text-amber-400">
            Also delete the branch
          </span>
          <span className="text-xs text-muted-foreground">
            Harder to undo than removing the worktree alone — only the reflog would let you recover
            it afterward.
          </span>
        </span>
      </label>
      {state.phase === "error" && <p className="text-sm text-destructive">{state.message}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={removing} onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={pending || removing} onClick={handleRemove}>
          {removing ? "Removing…" : "Remove worktree"}
        </Button>
      </DialogFooter>
    </>
  );
}
