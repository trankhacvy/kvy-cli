"use client";

import type { CheckRun, PullRequestInfo } from "@falcon/wire";
import { ExternalLink, RefreshCw } from "lucide-react";
import { MachineOfflineNotice } from "@/components/machine-offline-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMachineOnline } from "@/lib/use-machine-online";
import type { GithubChecksSnapshot, UseGithubChecksActions } from "../types";
import { DaemonUnsupportedError } from "../types";
import { useChecksPanel } from "../use-checks-panel";
import { useLiveGithubChecksActions } from "../use-live-github-checks-actions";
import { CheckRunRow } from "./CheckRunRow";

const PR_STATE_VARIANT: Record<PullRequestInfo["state"], "success" | "secondary" | "destructive"> =
  {
    open: "success",
    merged: "secondary",
    closed: "destructive",
  };

function PullRequestHeader({ pr }: { pr: PullRequestInfo }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted/40"
    >
      <Badge variant={PR_STATE_VARIANT[pr.state]}>{pr.draft ? "draft" : pr.state}</Badge>
      <span className="min-w-0 flex-1 truncate">
        #{pr.number} {pr.title}
      </span>
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

/** Copy for every non-`"ok"` `GithubChecksResult.state`, derived here rather than stored (design principle #3) — see `@falcon/wire`'s `rpc.ts` doc comment on `GithubChecksResultSchema` for what each state means. */
function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-sm text-muted-foreground">{children}</p>;
}

/**
 * Renders the Checks tab's body from already-resolved state — split out from
 * `ChecksPanel` so the copy for every one of the six UI states (the five
 * wire `GithubChecksResult.state` values plus the daemon-unsupported error)
 * has a direct render test with plain props, mirroring
 * `SessionTimelineScreen.tsx`'s own `LifecycleBanner`/`isSessionControlDisabled`
 * extraction for the same reason: no live query/hook graph needed to prove
 * the copy is right.
 */
export function ChecksBody({
  isLoading,
  error,
  checks,
  onFixWithAgent,
}: {
  isLoading: boolean;
  error: Error | null;
  checks: GithubChecksSnapshot | undefined;
  onFixWithAgent?: (check: CheckRun) => void;
}) {
  if (isLoading) {
    return <EmptyState>Loading checks…</EmptyState>;
  }

  if (error instanceof DaemonUnsupportedError) {
    return (
      <EmptyState>
        This machine&apos;s falcon daemon doesn&apos;t support CI checks yet — update falcon and
        restart the daemon.
      </EmptyState>
    );
  }

  if (error) {
    return <EmptyState>Could not load checks: {error.message}</EmptyState>;
  }

  if (!checks) {
    return <EmptyState>Loading checks…</EmptyState>;
  }

  switch (checks.state) {
    case "no-token":
      return (
        <EmptyState>
          GitHub is not connected on this machine — run <code>falcon github login</code> in a
          terminal on it.
        </EmptyState>
      );
    case "unsupported-remote":
      return (
        <EmptyState>{checks.message ?? "This workspace's remote isn't supported."}</EmptyState>
      );
    case "not-pushed":
      return <EmptyState>Commit and push your changes, then create a PR.</EmptyState>;
    case "no-pr":
      return (
        <EmptyState>
          No open pull request for {checks.branch ?? "this branch"} — create a PR to see CI checks.
        </EmptyState>
      );
    case "ok":
      return (
        <div className="flex flex-col gap-2 p-3">
          {checks.pr && <PullRequestHeader pr={checks.pr} />}
          {checks.checks && checks.checks.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {checks.checks.map((check, index) => (
                <CheckRunRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: `check.name` alone isn't a stable unique key — GitHub's check-runs list for one commit commonly contains multiple runs with the same name (a re-run creates a new entry rather than replacing the old one) — and the CheckRun wire shape carries no id; the list is replaced wholesale on every poll rather than reordered in place, same reasoning as UnifiedDiffViewer's/DiffView's own index-key precedent.
                  key={`${check.name}-${index}`}
                  check={check}
                  onFixWithAgent={onFixWithAgent}
                />
              ))}
            </ul>
          ) : (
            <EmptyState>No check runs reported for this pull request yet.</EmptyState>
          )}
        </div>
      );
  }
}

/**
 * The "Checks" tab (falcon-system-design.md §4.4 `github.checks`;
 * docs/features/github-pr-ci.md "GitHub PR/CI integration";
 * docs/competitive-notes-omnara.md #4): PR header (when one exists) plus its
 * check-run list, or a derived empty-state message otherwise (`ChecksBody`
 * above). Read-only — no re-run/cancel actions here (design: fast-follow).
 *
 * `useActions` is the injectable seam — mirrors `GitDiffPanel`'s own
 * `useActions` prop. Defaults to the real `useLiveGithubChecksActions`
 * (gated on the target machine's unwrapped DEK) — `mock-source.ts`'s
 * `useMockGithubChecksActions` stays exported for tests/standalone review.
 */
export function ChecksPanel({
  machineId,
  worktree,
  onFixWithAgent,
  useActions = useLiveGithubChecksActions,
}: {
  machineId: string;
  worktree: string;
  /** Wired to the same lifted `onSend`/`ComposerState.send` every other
   * session-panel-workflow action goes through — omitted entirely by
   * `SessionChecksScreen.tsx`'s other, non-panel usage of this component. */
  onFixWithAgent?: (check: CheckRun) => void;
  useActions?: UseGithubChecksActions;
}) {
  const actions = useActions(machineId);
  const machine = useMachineOnline(machineId);
  const { checks, error, isLoading, refetch } = useChecksPanel(
    actions,
    worktree,
    !machine.isKnownUnavailable,
  );
  return (
    <div className="flex flex-col gap-2">
      <MachineOfflineNotice state={machine} />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
          disabled={machine.isKnownUnavailable}
          onClick={() => void refetch()}
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>
      <ChecksBody
        isLoading={isLoading}
        error={error}
        checks={checks}
        onFixWithAgent={onFixWithAgent}
      />
    </div>
  );
}
