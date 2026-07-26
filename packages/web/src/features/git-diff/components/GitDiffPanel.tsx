"use client";

import { Button } from "@/components/ui/button";
import type { UseGitDiffActions } from "../types";
import { useGitPanel } from "../use-git-panel";
import { useLiveGitDiffActions } from "../use-live-git-diff-actions";
import { ChangedFilesList } from "./ChangedFilesList";
import { CompareAgainstSelect } from "./CompareAgainstSelect";
import { GitToolbar } from "./GitToolbar";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";

/**
 * Plain-language copy for the daemon's typed workspace error codes
 * (known-issues.md #3, `workspacePath.ts`'s `WorkspaceValidationErrorCode`)
 * — replaces raw `git` stderr ("fatal: not a git repository") with wording
 * a non-technical user can act on. Falls back to the raw message for any
 * other error (an ordinary git failure, a network/transport issue, etc.) —
 * this list is deliberately not exhaustive.
 */
const WORKSPACE_ERROR_COPY: Record<string, string> = {
  "workspace-missing":
    "We can't find this project's folder anymore. It may have been moved, renamed, or deleted.",
  "workspace-not-a-repo": "This folder isn't set up as a git project anymore.",
};

/**
 * The Git panel (falcon-prd.md FR-7.7 "Git panel"; plan.md §16 "4.1 Git
 * panel"; docs/features/git-write-actions.md): changed-files list on the
 * left, the selected file's (or every file's) unified diff on the right,
 * with a write-action toolbar above both (inline branch rename, commit,
 * push, force push behind a confirm dialog) and a "Compare against any
 * ref" selector. No longer read-only — commit/push/rename are real
 * mutating RPCs (`git.commit`/`git.push`/`git.renameBranch`); the only
 * still-deferred write action is opening a PR (`[P2]`, falcon-prd.md
 * FR-7.7).
 *
 * `useActions` is the injectable seam — mirrors `NewSessionScreen`'s
 * `useMachines`/`useActions` props. Defaults to the real
 * `useLiveGitDiffActions` (`(machineId) =>
 * machineRpcToGitDiffActions(createMachineRpcClient({...}))`, gated on the
 * target machine's unwrapped DEK) — `mock-source.ts`'s `useMockGitDiffActions`
 * stays exported for tests/standalone review, same precedent as
 * `NewSessionScreen`'s mocks. The toolbar lives here (not a separate
 * timeline-sidebar variant) so `/dashboard/session/[id]/git/`'s `SessionGitScreen`
 * gets it for free.
 */
export function GitDiffPanel({
  machineId,
  worktree,
  useActions = useLiveGitDiffActions,
}: {
  machineId: string;
  worktree: string;
  useActions?: UseGitDiffActions;
}) {
  const actions = useActions(machineId);
  const panel = useGitPanel(actions, worktree);
  const {
    status,
    statusError,
    statusErrorCode,
    isStatusLoading,
    selectedPath,
    selectFile,
    diff,
    diffError,
    diffErrorCode,
    isDiffLoading,
    compareRef,
    setCompareRef,
    branches,
    removeWorkspace,
    isRemoveWorkspacePending,
    removeWorkspaceDone,
  } = panel;

  if (isStatusLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading changed files…</p>;
  }

  const workspaceProblem = statusErrorCode && WORKSPACE_ERROR_COPY[statusErrorCode];

  if (statusError || !status) {
    if (workspaceProblem) {
      return (
        <div className="flex flex-col items-start gap-3 p-4 text-sm">
          <p className="text-destructive">{workspaceProblem}</p>
          {removeWorkspaceDone ? (
            <p className="text-muted-foreground">
              Removed. You can add it again from a new session's folder picker once it's back in
              place.
            </p>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={isRemoveWorkspacePending}
              onClick={() => removeWorkspace()}
            >
              {isRemoveWorkspacePending ? "Removing…" : "Remove this workspace"}
            </Button>
          )}
        </div>
      );
    }
    return (
      <p className="p-4 text-sm text-destructive">
        Could not load git status{statusError ? `: ${statusError}` : "."}
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <GitToolbar panel={panel} />
      <div className="flex items-center justify-end px-1">
        <CompareAgainstSelect
          compareRef={compareRef}
          onChange={setCompareRef}
          branches={branches}
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
        <aside className="border-border md:border-r md:pr-3">
          <ChangedFilesList status={status} selectedPath={selectedPath} onSelect={selectFile} />
        </aside>
        <section className="min-w-0">
          {isDiffLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>
          ) : diffError ? (
            <p className="p-4 text-sm text-destructive">
              {(diffErrorCode && WORKSPACE_ERROR_COPY[diffErrorCode]) ??
                `Could not load diff: ${diffError}`}
            </p>
          ) : diff ? (
            <UnifiedDiffViewer diff={diff} />
          ) : null}
        </section>
      </div>
    </div>
  );
}
