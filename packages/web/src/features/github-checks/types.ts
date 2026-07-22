import type { GithubChecksResult } from "@falcon/wire";

/**
 * View-model types for the "Checks" tab (falcon-system-design.md §4.4
 * `github.checks`; docs/features/github-pr-ci.md "GitHub PR/CI
 * integration"; docs/competitive-notes-omnara.md #4). Structural clone of
 * `features/git-diff/types.ts` — read-only for the MVP, same seam pattern.
 *
 * `GithubChecksSnapshot` is re-exported straight off `@falcon/wire` rather
 * than redeclared: the RPC result is already exactly what this panel wants
 * to render, same reasoning `features/git-diff/types.ts`'s own doc comment
 * gives for its `GitStatusSnapshot`.
 */
export type GithubChecksSnapshot = GithubChecksResult;

/**
 * Thrown by a live `GithubChecksActions.fetchChecks` when the target
 * machine's daemon doesn't recognize the `github.checks` RPC yet (an
 * older, not-yet-upgraded daemon) — distinguished from every other failure
 * so the panel can show "update falcon and restart the daemon" instead of a
 * generic error (docs/features/github-pr-ci.md Phase 4).
 */
export class DaemonUnsupportedError extends Error {
  constructor(message = "This machine's falcon daemon doesn't support CI checks yet.") {
    super(message);
    this.name = "DaemonUnsupportedError";
  }
}

/**
 * The RPC surface the Checks tab needs, seamed off from *how* those calls
 * reach the daemon — mirrors `features/git-diff`'s `GitDiffActions`. Mock by
 * default (`mock-source.ts`), swapped for the real
 * `machineRpcToGithubChecksActions(createMachineRpcClient({...}))`
 * (`live-actions.ts`) once a screen has a live `apiSocket` + a crypto client
 * holding the target machine's unwrapped DEK.
 */
export interface GithubChecksActions {
  /** Fetches the PR/CI check state for `worktree`. Throws on failure — including a typed `DaemonUnsupportedError` for an older daemon (see above). */
  fetchChecks(worktree: string): Promise<GithubChecksSnapshot>;
}

/** One Checks-tab actions client per chosen machine — mirrors `UseGitDiffActions = (machineId) => GitDiffActions`. */
export type UseGithubChecksActions = (machineId: string) => GithubChecksActions;
