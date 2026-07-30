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
import { Input } from "@/components/ui/input";
import { useSessionMetadataPatchMutation } from "@/lib/use-session-metadata-write";

/**
 * Rename (docs/features/session-lifecycle-actions.md Phase 4) — shared
 * between the Home card's dropdown (`SessionCardActions`) and the timeline
 * header's (`SessionActionsMenu`), same "one dialog component, two call
 * sites" shape as the delete-confirm `Dialog` both menus already duplicate.
 * Controlled (`open`/`onOpenChange`) rather than owning its own trigger, so
 * each menu's own `DropdownMenuItem onSelect` decides when it opens.
 */
export function RenameSessionDialog({
  sessionId,
  currentTitle,
  open,
  onOpenChange,
}: {
  sessionId: string;
  currentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(currentTitle);
  const mutation = useSessionMetadataPatchMutation(sessionId);

  // Re-seed the input from the latest known title each time the dialog
  // opens (not on every keystroke-adjacent render) — mirrors a fresh-open
  // always starting from the current server state, same as the delete
  // dialogs' own confirm-step reset precedent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only `open` should re-seed the field; `currentTitle` re-running this on every parent re-render while the dialog is open would stomp on in-progress typing.
  useEffect(() => {
    if (open) setValue(currentTitle);
  }, [open]);

  const trimmed = value.trim();
  const unchanged = trimmed === currentTitle.trim();

  function handleOpenChange(next: boolean) {
    if (!next) mutation.reset();
    onOpenChange(next);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (trimmed.length === 0 || unchanged) return;
    // `titleSource: "manual"` — the CLI's provider-summary auto-title
    // (`sessionMetadata.ts`'s `updateTitle`) checks this and refuses to
    // overwrite a title the user set by hand.
    mutation.mutate((current) => ({ ...current, title: trimmed, titleSource: "manual" }), {
      onSuccess: () => handleOpenChange(false),
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>Give this session a new title.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Session title"
            className="mt-4"
            maxLength={200}
          />
          {mutation.isError && (
            <p className="mt-2 text-sm text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Could not rename."}
            </p>
          )}
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || trimmed.length === 0 || unchanged}
            >
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
