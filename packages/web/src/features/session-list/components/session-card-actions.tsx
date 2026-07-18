"use client";

import { Archive, Trash2 } from "lucide-react";
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
 * Archive/delete actions for one Home-screen `SessionCard` (plan-v2.md W4.2).
 * Rendered as a sibling of the card's own `Link` (see `SessionCard`'s own
 * comment on why) — plain `<button>`s here never nest inside that anchor,
 * so no `preventDefault`/`stopPropagation` dance is needed to stop a click
 * from also navigating.
 *
 * Archive has no confirm step (a status flip, easily reversed by a future
 * "unarchive" — not destructive). Delete does: it's a hard row delete
 * (`sessionArchive.ts`'s `DELETE /v1/sessions/:id`), mirroring `ControlBar`'s
 * "End session" confirm-dialog precedent (plan-v2.md W2.3).
 */
export function SessionCardActions({ sessionId, title }: { sessionId: string; title: string }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const archiveMutation = useArchiveSessionMutation();
  const deleteMutation = useDeleteSessionMutation();

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        title="Archive session"
        aria-label="Archive session"
        disabled={archiveMutation.isPending}
        onClick={() => archiveMutation.mutate(sessionId)}
      >
        <Archive className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 text-destructive hover:text-destructive"
        title="Delete session"
        aria-label="Delete session"
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{title}"?</DialogTitle>
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
                deleteMutation.mutate(sessionId, { onSuccess: () => setDeleteOpen(false) })
              }
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
