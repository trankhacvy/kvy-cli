import type { GithubChecksResult } from "@falcon/wire";

/**
 * The manual (browser) "Create/open PR" action's target URL, derived from
 * the already-fetched `github.checks` result (no new RPC — session-panel-
 * workflow-plan.md Phase 2). `repo`/`branch`/`pr` are independent optional
 * fields on a flat object, not narrowed by `state` alone, so both must be
 * checked explicitly even inside a matching `state`. `null` means "nothing
 * to compare/open yet" (`not-pushed`/`no-token`/`unsupported-remote`, or a
 * `no-pr`/`ok` state missing the fields it needs) — the caller hides the
 * action entirely in that case.
 */
export function manualCompareUrl(checks: GithubChecksResult | undefined): string | null {
  if (!checks) return null;
  if (checks.state === "no-pr" && checks.repo && checks.branch) {
    return `https://github.com/${checks.repo.owner}/${checks.repo.name}/compare/${checks.branch}?expand=1`;
  }
  if (checks.state === "ok" && checks.pr) return checks.pr.url;
  return null;
}
