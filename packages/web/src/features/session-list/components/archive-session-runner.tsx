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
import { useArchiveSession } from "@/lib/use-archive-session";

/**
 * Mounted only while a worktree-mode session's Archive action is running —
 * same "crypto/RPC machinery only mounts while active" discipline as
 * `RemoveWorktreeDialog`, so a screen full of worktree-mode sessions never
 * spins up one crypto worker per row. Renders nothing for a clean worktree
 * (removed and archived silently, no confirm needed); only a dirty worktree
 * surfaces a dialog, escalating exactly like `RemoveWorktreeDialog`'s own
 * confirm-force step.
 */
export function ArchiveSessionRunner({
  sessionId,
  machineId,
  workspaceId,
  title,
  onArchived,
  onClose,
}: {
  sessionId: string;
  machineId: string;
  workspaceId: string;
  title: string;
  onArchived: () => void;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const { state, confirmForceArchive } = useArchiveSession({
    sessionId,
    machineId,
    workspaceId,
    onArchived: () => {
      onArchived();
      onClose();
    },
  });

  function handleConfirm() {
    setSubmitting(true);
    confirmForceArchive();
  }

  if (state.phase === "error") {
    return (
      <Dialog open onOpenChange={(next) => !next && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Couldn't archive "{title}"</DialogTitle>
            <DialogDescription>{state.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (state.phase !== "confirm-force" && !submitting) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive "{title}"?</DialogTitle>
          <DialogDescription>
            Its worktree has uncommitted or untracked changes. Archiving now will discard them
            permanently.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <Badge variant="warning">Needs attention</Badge>
          <p className="text-muted-foreground">
            The on-disk worktree still has changes that were never committed or pushed.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={submitting} onClick={handleConfirm}>
            {submitting ? "Archiving…" : "Discard changes and archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
