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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { resolveBranchRenameSubmit, resolveCommitSubmit } from "../git-toolbar-state";
import type { GitPanelState } from "../use-git-panel";

/**
 * The Git panel's write-action toolbar (docs/features/git-write-actions.md
 * Phase 5): inline branch rename, a one-click commit box (defaults to
 * staging everything — `git add -A` — via `live-actions.ts`'s own
 * `stageAll` default, this checkbox is the override), Push, and Force Push
 * behind a confirm dialog. Every mutation error surfaces the raw
 * `GitExecError` message inline (`text-destructive`) rather than a Falcon
 * abstraction — this IS the credential-failure UX (docs/features/
 * git-write-actions.md: "push auth is the machine's ambient git credential
 * helper/SSH agent").
 */
export function GitToolbar({ panel }: { panel: GitPanelState }) {
  const { status } = panel;
  const [editingBranch, setEditingBranch] = useState(false);
  const [branchDraft, setBranchDraft] = useState("");
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(true);
  const [forcePushOpen, setForcePushOpen] = useState(false);

  if (!status) return null;

  function startEditingBranch() {
    setBranchDraft(status?.branch ?? "");
    setEditingBranch(true);
  }

  function submitBranchRename() {
    setEditingBranch(false);
    const to = resolveBranchRenameSubmit(branchDraft, status?.branch ?? "");
    if (to === null) return;
    panel.renameBranch(to);
  }

  function handleCommit() {
    const params = resolveCommitSubmit(message, stageAll);
    if (params === null) return;
    panel.commit(params);
    setMessage("");
  }

  function handleCommitAndPush() {
    const params = resolveCommitSubmit(message, stageAll);
    if (params === null) return;
    setMessage("");
    void panel.commitAndPush(params);
  }

  // Any one of these three mutations running a `git` process against this
  // worktree must block the other two — `commitAndPush`'s own push phase
  // runs after `isCommitPending` has already dropped back to false, so
  // gating each button on only its own mutation's pending flag lets a click
  // during that window start a second, concurrent `git` invocation.
  const gitOperationPending =
    panel.isCommitPending || panel.isPushPending || panel.isCommitAndPushPending;

  return (
    <div className="flex flex-col gap-3 border-b border-border px-1 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        {editingBranch ? (
          <Input
            autoFocus
            value={branchDraft}
            onChange={(e) => setBranchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitBranchRename();
              if (e.key === "Escape") setEditingBranch(false);
            }}
            onBlur={submitBranchRename}
            className="h-7 w-48 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={startEditingBranch}
            className="rounded-md px-1.5 py-0.5 text-sm font-medium hover:bg-muted/60"
            title="Click to rename this branch"
          >
            {status.branch}
          </button>
        )}
        {panel.isRenameBranchPending && <Spinner className="size-3.5" />}
        {status.ahead > 0 && <span className="text-xs text-muted-foreground">↑{status.ahead}</span>}
        {status.behind > 0 && (
          <span className="text-xs text-muted-foreground">↓{status.behind}</span>
        )}
        {panel.renameBranchResult?.hadUpstream && (
          <span className="text-xs text-muted-foreground">
            remote branch keeps its old name until you push
          </span>
        )}
        {panel.renameBranchError && (
          <span className="text-xs text-destructive">{panel.renameBranchError}</span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Textarea
          id="git-toolbar-commit-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Commit message"
          className="min-h-10 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={message.trim() === "" || gitOperationPending}
            onClick={handleCommit}
          >
            {panel.isCommitPending ? "Committing…" : "Commit"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={message.trim() === "" || gitOperationPending}
            onClick={handleCommitAndPush}
          >
            {panel.isCommitAndPushPending ? "Committing & pushing…" : "Commit & Push"}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={stageAll}
              onChange={(e) => setStageAll(e.target.checked)}
            />
            Include untracked
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={gitOperationPending}
            onClick={() => panel.push({})}
          >
            {panel.isPushPending ? "Pushing…" : "Push"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={gitOperationPending}
            onClick={() => setForcePushOpen(true)}
          >
            Force Push
          </Button>
        </div>
        {panel.commitResult?.nothingToCommit && (
          <span className="text-xs text-muted-foreground">Nothing to commit.</span>
        )}
        {panel.commitError && <span className="text-xs text-destructive">{panel.commitError}</span>}
        {panel.pushError && (
          <span className="text-xs text-destructive">
            {panel.commitResult?.committed
              ? `Committed, but push failed: ${panel.pushError}`
              : panel.pushError}
          </span>
        )}
      </div>

      <Dialog open={forcePushOpen} onOpenChange={setForcePushOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force push {status.branch}?</DialogTitle>
            <DialogDescription>
              Force push uses --force-with-lease; it can still discard commits others pushed.
              Continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForcePushOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setForcePushOpen(false);
                panel.push({ force: true });
              }}
            >
              Force push
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
