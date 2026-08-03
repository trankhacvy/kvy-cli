"use client";

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
import { Input } from "@/components/ui/input";
import { resolveSetRemoteSubmit } from "../git-toolbar-state";

/**
 * "Add a remote" dialog — a
 * structural clone of `GitToolbar.tsx`'s own Force Push confirm `Dialog`:
 * one field for the URL, one for the name (prefilled `origin`), Cancel +
 * Save, the mutation's own error rendered inline in `text-destructive`.
 * Submit validation lives in `git-toolbar-state.ts`'s
 * `resolveSetRemoteSubmit` so it's unit-testable without a DOM.
 */
export function AddRemoteDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (params: { url: string; name?: string }) => void;
  isPending: boolean;
  error: string | null;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("origin");

  function handleSubmit() {
    const params = resolveSetRemoteSubmit(url, name);
    if (params === null) return;
    onSubmit(params);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a remote</DialogTitle>
          <DialogDescription>
            This project has no remote yet. Add one so Push has somewhere to go.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="add-remote-url">
            URL
            <Input
              id="add-remote-url"
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="git@github.com:org/repo.git"
              className="text-sm"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="add-remote-name">
            Name
            <Input
              id="add-remote-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm"
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || url.trim() === ""}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
