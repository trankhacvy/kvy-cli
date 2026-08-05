import type { GithubRerunChecksParams, GithubRerunChecksResult } from "@kvy/wire";
import {
  type GithubClientDeps,
  githubApiPost,
  listWorkflowRunsForSha,
  resolveGithubPrTarget,
} from "./githubClient.js";

export async function rerunGithubChecks(
  params: GithubRerunChecksParams,
  deps: GithubClientDeps = {},
): Promise<GithubRerunChecksResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const target = await resolveGithubPrTarget(params.worktree, deps);
  if (!target.ok) throw new Error(`cannot rerun checks: ${target.result.state}`);

  const runs = await listWorkflowRunsForSha(
    target.repo,
    target.pr.headSha,
    target.token,
    fetchImpl,
  );
  const failedRuns = runs.filter((run) => run.conclusion === "failure");
  const cancelledRuns = runs.filter((run) => run.conclusion === "cancelled");
  const baseUrl = `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}/actions/runs`;
  await Promise.all([
    ...failedRuns.map((run) =>
      githubApiPost(`${baseUrl}/${run.id}/rerun-failed-jobs`, target.token, {}, fetchImpl),
    ),
    // Cancelled runs have no failed jobs to target — rerun the whole run.
    ...cancelledRuns.map((run) =>
      githubApiPost(`${baseUrl}/${run.id}/rerun`, target.token, {}, fetchImpl),
    ),
  ]);
  return { ok: true, rerunCount: failedRuns.length + cancelledRuns.length };
}
