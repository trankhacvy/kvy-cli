"use client";

import { Button } from "@/components/ui/button";
import type { GitPanelState } from "../use-git-panel";

/**
 * Plain-language copy for the daemon's typed workspace error codes
 * (known-issues.md #3, `workspacePath.ts`'s `WorkspaceValidationErrorCode`)
 * — replaces raw `git` stderr ("fatal: not a git repository") with wording
 * a non-technical user can act on. Falls back to the raw message for any
 * other error (an ordinary git failure, a network/transport issue, etc.) —
 * this list is deliberately not exhaustive.
 */
export const WORKSPACE_ERROR_COPY: Record<string, string> = {
  "workspace-missing":
    "We can't find this project's folder anymore. It may have been moved, renamed, or deleted.",
  "workspace-not-a-repo": "This folder isn't set up as a git project.",
};

/**
 * Shared "couldn't load git status" state for both the full Git page
 * (`GitDiffPanel`) and the session sidebar's Changes tab (`SessionSidePanel`'s
 * `ChangesTab`) — the two duplicated this rendering independently and had
 * drifted apart (one had the friendly copy below, the other still showed the
 * raw `git` error string). A recognized workspace problem is expected,
 * everyday state — not a git repo, or the folder moved — so it renders
 * muted like any other "nothing to show here" empty state, matching
 * `ChecksPanel`'s `EmptyState` convention; only a genuinely unrecognized
 * failure keeps the alarming red text.
 */
export function GitStatusError({ panel }: { panel: GitPanelState }) {
  const {
    statusError,
    statusErrorCode,
    removeWorkspace,
    isRemoveWorkspacePending,
    removeWorkspaceDone,
  } = panel;
  const workspaceProblem = statusErrorCode && WORKSPACE_ERROR_COPY[statusErrorCode];

  if (workspaceProblem) {
    return (
      <div className="flex flex-col items-start gap-3 p-4 text-sm">
        <p className="text-muted-foreground">{workspaceProblem}</p>
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
