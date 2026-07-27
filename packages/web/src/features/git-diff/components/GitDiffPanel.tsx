"use client";

import type { UseGitDiffActions } from "../types";
import { useGitPanel } from "../use-git-panel";
import { useLiveGitDiffActions } from "../use-live-git-diff-actions";
import { ChangedFilesList } from "./ChangedFilesList";
import { CompareAgainstSelect } from "./CompareAgainstSelect";
import { GitStatusError, WORKSPACE_ERROR_COPY } from "./GitStatusError";
import { GitToolbar } from "./GitToolbar";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";

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
  } = panel;

  if (isStatusLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading changed files…</p>;
  }

  if (statusError || !status) {
    return <GitStatusError panel={panel} />;
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
