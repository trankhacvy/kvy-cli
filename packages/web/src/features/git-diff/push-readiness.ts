import type { GitRemoteInfo, GitStatusResult } from "@falcon/wire";

/**
 * Whether the Git panel's Push button can possibly succeed, derived — never
 * stored — from data the panel already holds (design principle #3). Modeled
 * on `@falcon/wire`'s `GithubChecksResult.state`: every distinct empty/
 * blocked case is its own value so the UI renders derived copy instead of
 * string-matching git's stderr (`GitToolbar.tsx` prints `pushError`
 * verbatim today, which is the right behaviour for a CREDENTIAL failure and
 * the wrong one for "there is no remote to push to" — a condition fully
 * knowable before the click).
 *
 * Deliberately NOT a daemon-side state like `github.checks`'s: that one
 * needs a machine-local GitHub token and a network round-trip, so it has to
 * be computed where those live. This one is a pure function of `git.status`
 * + `git.remotes`, both of which the panel can already fetch.
 *
 *   - "unknown":      remotes haven't loaded yet — never render a blocked
 *                     state on a query that simply hasn't resolved.
 *   - "no-remote":    the repo has no remotes at all. Push is impossible;
 *                     offer "Add a remote" instead.
 *   - "detached":     `git.status` reports HEAD detached — `gitPush.ts`
 *                     throws "cannot push: HEAD is detached" for exactly
 *                     this, so catch it before the round-trip.
 *   - "no-upstream":  remotes exist but this branch has none. Push still
 *                     works; it just needs `-u` (`setUpstream`), which the
 *                     UI can pass automatically instead of surfacing git's
 *                     "has no upstream branch" hint.
 *   - "ready":        nothing known to be in the way. Any failure from here
 *                     on is a genuine git/credential error and keeps
 *                     today's verbatim-stderr treatment.
 */
export type PushReadiness = "unknown" | "no-remote" | "detached" | "no-upstream" | "ready";

export function derivePushReadiness(
  status: GitStatusResult | undefined,
  remotes: GitRemoteInfo[] | undefined,
  branches: { name: string; isCurrent: boolean; upstream?: string }[],
): PushReadiness {
  if (status === undefined || remotes === undefined) return "unknown";
  if (status.branch === "" || status.branch === "(detached)") return "detached";
  if (remotes.length === 0) return "no-remote";
  const current = branches.find((b) => b.isCurrent);
  if (current && current.upstream === undefined) return "no-upstream";
  return "ready";
}

/** Copy for each blocked state — plain language, no internal vocabulary (CLAUDE.md auth/UX rule #4). `"ready"`/`"unknown"` have none: they render nothing. */
export const PUSH_READINESS_COPY: Partial<Record<PushReadiness, string>> = {
  "no-remote": "This project has no remote yet, so there's nowhere to push.",
  detached: "This project isn't on a branch right now, so there's nothing to push.",
};
