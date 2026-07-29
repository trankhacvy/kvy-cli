"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { GithubChecksActions } from "./types";

/**
 * The Checks tab's data-fetching state (docs/features/github-pr-ci.md
 * Phase 4). Unlike the Git panel's `useGitPanel` (a point-in-time fetch the
 * user refreshes by re-selecting a file), CI checks change *while the panel
 * sits open* — a queued run flips to in_progress to completed with nobody
 * touching the tab — so this polls: `refetchInterval: 60_000`,
 * `refetchIntervalInBackground: false` (foreground tabs only).
 *
 * 60 seconds is a deliberate floor, not an arbitrary default: GitHub's REST
 * API caps an authenticated token at 5000 requests/hour: PRD/design's Checks
 * tab makes 2 calls per fetch (pulls lookup + check-runs), so one
 * continuously-open tab at 60s costs ~120 req/hr — comfortable headroom for
 * a single session, but it scales linearly with how many Checks tabs a user
 * leaves open simultaneously (docs/features/github-pr-ci.md's risk note).
 * ETag conditional requests would cut this materially but are deliberately
 * deferred — they slot into `daemon/githubChecks.ts` later without any wire
 * change, per that same doc's note.
 */
export function useChecksPanel(actions: GithubChecksActions, worktree: string) {
  const query = useQuery({
    queryKey: ["github-checks", worktree],
    queryFn: () => actions.fetchChecks(worktree),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  // `actions` starts out as a permanently-rejecting stub until this
  // machine's crypto key finishes unwrapping (`useLiveGithubChecksActions`)
  // — a fetch raced against that stub can get stuck in a state nothing
  // retries until the next `refetchInterval` tick, which itself only fires
  // for a foreground tab. Force a refetch the moment `actions`'s identity
  // changes after mount, the same fix `use-git-panel.ts` applies.
  const isFirstActionsRender = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed only on `actions` — see use-git-panel.ts's identical effect.
  useEffect(() => {
    if (isFirstActionsRender.current) {
      isFirstActionsRender.current = false;
      return;
    }
    void query.refetch();
  }, [actions]);

  return {
    checks: query.data,
    error: query.error instanceof Error ? query.error : null,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
