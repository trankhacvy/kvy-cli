"use client";

import { Archive, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useArchiveSessionMutation, useDeleteSessionMutation } from "@/lib/use-session-lifecycle";

/**
 * Archive/delete for the timeline header (plan-v2.md W4.2 "wire buttons on
 * … session header") — same two mutations `SessionCardActions` (Home row)
 * uses, adapted for a screen that's currently *looking at* the session being
 * acted on: both actions navigate back to Home on success, since there's
 * nothing left here to show (archive still technically leaves the session
 * viewable, but there's no reason to stay on a screen the user just chose to
 * leave behind; delete makes staying impossible outright).
 */
export function SessionHeaderActions({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const archiveMutation = useArchiveSessionMutation();
  const deleteMutation = useDeleteSessionMutation();

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={archiveMutation.isPending}
        onClick={() => archiveMutation.mutate(sessionId, { onSuccess: () => router.push("/") })}
      >
        <Archive className="size-3.5" />
        Archive
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this session?</DialogTitle>
            <DialogDescription>
              Permanently deletes this session and its transcript. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteMutation.isError && (
            <p className="text-sm text-destructive">
              {deleteMutation.error instanceof Error
                ? deleteMutation.error.message
                : "Could not delete the session."}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleteMutation.isPending}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteMutation.mutate(sessionId, { onSuccess: () => router.push("/") })
              }
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
