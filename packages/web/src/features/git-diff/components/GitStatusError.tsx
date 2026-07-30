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
    initRepo,
    isInitRepoPending,
    initRepoError,
    initRepoResult,
  } = panel;
  const workspaceProblem = statusErrorCode && WORKSPACE_ERROR_COPY[statusErrorCode];

  if (workspaceProblem) {
    // "Set up git here" is only ever offered for `workspace-not-a-repo`:
    // for `workspace-missing` the folder itself is gone, and `git init`
    // would be both impossible (the daemon's registry authorizer refuses a
    // path that doesn't resolve) and wrong (it can't recreate the user's
    // files).
    const canInitialize = statusErrorCode === "workspace-not-a-repo";

    return (
      <div className="flex flex-col items-start gap-3 p-4 text-sm">
        <p className="text-muted-foreground">{workspaceProblem}</p>

        {canInitialize && initRepoResult?.state === "inside-existing-repo" && (
          <p className="text-muted-foreground">
            This folder is already part of the project at{" "}
            <code className="rounded bg-muted px-1 py-0.5">{initRepoResult.existingRoot}</code> —
            open that project instead of starting a new one here.
          </p>
        )}
        {canInitialize && initRepoError && <p className="text-destructive">{initRepoError}</p>}

        {canInitialize && initRepoResult?.state !== "inside-existing-repo" && (
          <Button size="sm" disabled={isInitRepoPending} onClick={() => initRepo()}>
            {isInitRepoPending ? "Setting up…" : "Set up git here"}
          </Button>
        )}

        {/* Destructive action stays a link, never a button next to a safe
            one (CLAUDE.md auth/UX rule #5 — same shape as
            components/auth/start-over-link.tsx), and states its consequence. */}
        {removeWorkspaceDone ? (
          <p className="text-muted-foreground">
            Removed. You can add it again from a new session's folder picker once it's back in
            place.
          </p>
        ) : (
          <button
            type="button"
            disabled={isRemoveWorkspacePending}
            onClick={() => removeWorkspace()}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          >
            {isRemoveWorkspacePending
              ? "Removing…"
              : "Forget this project — Falcon stops tracking the folder, nothing on disk changes"}
          </button>
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
