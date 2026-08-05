import type { GithubCancelChecksParams, GithubCancelChecksResult } from "@kvy/wire";
import {
  type GithubClientDeps,
  githubApiPost,
  listWorkflowRunsForSha,
  resolveGithubPrTarget,
} from "./githubClient.js";

export async function cancelGithubChecks(
  params: GithubCancelChecksParams,
  deps: GithubClientDeps = {},
): Promise<GithubCancelChecksResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const target = await resolveGithubPrTarget(params.worktree, deps);
  if (!target.ok) throw new Error(`cannot cancel checks: ${target.result.state}`);

  const runs = await listWorkflowRunsForSha(
    target.repo,
    target.pr.headSha,
    target.token,
    fetchImpl,
  );
  const activeRuns = runs.filter((run) => run.status === "queued" || run.status === "in_progress");
  await Promise.all(
    activeRuns.map((run) =>
      githubApiPost(
        `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}/actions/runs/${run.id}/cancel`,
        target.token,
        {},
        fetchImpl,
      ),
    ),
  );
  return { ok: true, cancelledCount: activeRuns.length };
}
