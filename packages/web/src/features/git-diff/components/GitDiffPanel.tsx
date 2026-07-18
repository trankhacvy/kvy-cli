"use client";

import type { UseGitDiffActions } from "../types";
import { useGitPanel } from "../use-git-panel";
import { useLiveGitDiffActions } from "../use-live-git-diff-actions";
import { ChangedFilesList } from "./ChangedFilesList";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";

/**
 * The Git panel (falcon-prd.md FR-7.7 "Git panel"; plan.md §16 "4.1 Git
 * panel"): changed-files list on the left, the selected file's (or every
 * file's) unified diff on the right. Read-only for the MVP — no commit/
 * push/PR actions here (design: fast-follow, `[P2]`).
 *
 * `useActions` is the injectable seam — mirrors `NewSessionScreen`'s
 * `useMachines`/`useActions` props. Defaults to the real
 * `useLiveGitDiffActions` (`(machineId) =>
 * machineRpcToGitDiffActions(createMachineRpcClient({...}))`, gated on the
 * target machine's unwrapped DEK) — `mock-source.ts`'s `useMockGitDiffActions`
 * stays exported for tests/standalone review, same precedent as
 * `NewSessionScreen`'s mocks.
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
  const {
    status,
    statusError,
    isStatusLoading,
    selectedPath,
    selectFile,
    diff,
    diffError,
    isDiffLoading,
  } = useGitPanel(actions, worktree);

  if (isStatusLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading changed files…</p>;
  }

  if (statusError || !status) {
    return (
      <p className="p-4 text-sm text-destructive">
        Could not load git status{statusError ? `: ${statusError}` : "."}
      </p>
    );
  }

  return (
    <div className="grid h-full grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
      <aside className="border-border md:border-r md:pr-3">
        <ChangedFilesList status={status} selectedPath={selectedPath} onSelect={selectFile} />
      </aside>
      <section className="min-w-0">
        {isDiffLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading diff…</p>
        ) : diffError ? (
          <p className="p-4 text-sm text-destructive">Could not load diff: {diffError}</p>
        ) : diff ? (
          <UnifiedDiffViewer diff={diff} />
        ) : null}
      </section>
    </div>
  );
}
