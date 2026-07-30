"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The "stop tracking this folder" control - shared by `GitStatusError.tsx`
 * (offered when a workspace's folder is gone) and Workspace Settings' General
 * tab (offered any time, as a deliberate action). A confirm dialog, not an
 * instant click or an inline link: this is a destructive-sounding action, so
 * it states its actual (much smaller) blast radius up front - deregisters
 * the workspace from the daemon's local registry only, no files touched, no
 * session history lost - and requires an explicit second click before
 * running. Closes itself once `done` flips true.
 */
export function RemoveWorkspaceControl({
  onRemove,
  isPending,
  done,
}: {
  onRemove: () => void;
  isPending: boolean;
  done: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (done) setOpen(false);
  }, [done]);

  if (done) {
    return (
      <p className="text-sm text-muted-foreground">
        Removed. You can add it again from a new session's folder picker once it's back in place.
      </p>
    );
  }

  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Remove workspace
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this workspace?</DialogTitle>
            <DialogDescription>
              Falcon stops tracking this folder. Nothing on disk changes, and every session's
              history stays exactly as readable as it is now. Add it again anytime from a new
              session's folder picker.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={isPending} onClick={onRemove}>
              {isPending ? "Removing…" : "Remove workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
