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
              Kvy stops tracking this folder. Nothing on disk changes, and every session's history
              stays exactly as readable as it is now. Add it again anytime from a new session's
              folder picker.
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
