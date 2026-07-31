"use client";

import type { SessionRow } from "@falcon/wire";
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
import { useArchiveSession } from "@/lib/use-archive-session";
import { canOfferRemoveWorktree } from "./session-card-actions-logic";

/**
 * The one and only Archive action (replacing the old separate Stop/Restart/
 * Remove worktree/Mark done/Delete/Restore menu items — conductor.build's
 * model: a single Archive that stops the process, cleans up the worktree,
 * and leaves the transcript readable but not interactive). Shared, byte-for-
 * byte identical, between the Home card's dropdown (`SessionCardActions`)
 * and the timeline header's (`SessionActionsMenu`) — same "one dialog
 * component, two call sites" precedent as `RenameSessionDialog`.
 *
 * One dialog, no separate confirm-then-runner split: opens on a plain
 * "Archive this session?" confirm step (nothing happens before that button
 * is pressed), then runs stop → remove-worktree → archive. A dirty worktree
 * escalates the SAME dialog to a second, more explicit step instead of
 * silently discarding uncommitted/untracked changes.
 *
 * Crypto/RPC machinery (`useArchiveSession`, which owns a session-scoped
 * bridge for `stop` and a machine-scoped one for `worktree.remove`) only
 * mounts while `open` — a screen full of session cards never spins up one
 * worker per row.
 */
export function ArchiveSessionDialog({
  sessionId,
  title,
  status,
  machineId,
  workspaceId,
  open,
  onOpenChange,
  onArchived,
}: {
  sessionId: string;
  title: string;
  status: SessionRow["status"];
  machineId: string | null;
  /** This session's `workspaceId` — `null` (or a plain repo-root path) means
   * there's no worktree to clean up; the flow just stops (if live) and
   * archives. */
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the session is actually archived — e.g. the timeline
   * header navigates back to Home; the Home card has nothing extra to do. */
  onArchived?: () => void;
}) {
  const hasWorktree = canOfferRemoveWorktree(machineId, workspaceId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive "{title}"?</DialogTitle>
          <DialogDescription>
            {hasWorktree
              ? "Stops the process if it's still running and removes its worktree from disk. You'll still be able to view the transcript afterward, but not interact with it."
              : "Stops the process if it's still running. You'll still be able to view the transcript afterward, but not interact with it."}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ArchiveConfirmBody
            sessionId={sessionId}
            status={status}
            machineId={machineId}
            workspaceId={workspaceId}
            onDone={() => onOpenChange(false)}
            onArchived={onArchived}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ArchiveConfirmBody({
  sessionId,
  status,
  machineId,
  workspaceId,
  onDone,
  onArchived,
}: {
  sessionId: string;
  status: SessionRow["status"];
  machineId: string | null;
  workspaceId: string | null;
  onDone: () => void;
  onArchived?: () => void;
}) {
  const { state, pending, runArchive, confirmForceArchive } = useArchiveSession({
    sessionId,
    status,
    machineId,
    workspaceId,
    onArchived: () => {
      onArchived?.();
      onDone();
    },
  });

  if (state.phase === "confirm-force") {
    return (
      <>
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <Badge variant="warning">Needs attention</Badge>
          <p className="text-muted-foreground">
            This worktree has uncommitted or untracked changes. Archiving now will discard them
            permanently.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirmForceArchive}>
            Discard changes and archive
          </Button>
        </DialogFooter>
      </>
    );
  }

  const running =
    state.phase === "stopping" || state.phase === "checking" || state.phase === "archiving";

  return (
    <>
      {pending && <p className="text-sm text-muted-foreground">Preparing…</p>}
      {state.phase === "error" && <p className="text-sm text-destructive">{state.message}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={running} onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={pending || running} onClick={runArchive}>
          {running ? "Archiving…" : "Archive"}
        </Button>
      </DialogFooter>
    </>
  );
}
