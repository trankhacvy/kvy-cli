import type { CheckStep, GithubCheckStepsParams, GithubCheckStepsResult } from "@kvy/wire";
import {
  type GithubClientDeps,
  githubApiGet,
  listWorkflowRunsForSha,
  resolveGithubPrTarget,
} from "./githubClient.js";

interface RawStep {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

interface RawJob {
  name: string;
  steps: RawStep[] | null;
}

interface RawJobsResponse {
  jobs: RawJob[];
}

function toUnixSeconds(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function mapStep(raw: RawStep): CheckStep {
  const step: CheckStep = { name: raw.name, status: raw.status, number: raw.number };
  if (raw.conclusion) step.conclusion = raw.conclusion as CheckStep["conclusion"];
  const startedAt = toUnixSeconds(raw.started_at);
  if (startedAt !== undefined) step.startedAt = startedAt;
  const completedAt = toUnixSeconds(raw.completed_at);
  if (completedAt !== undefined) step.completedAt = completedAt;
  return step;
}

export async function getGithubCheckSteps(
  params: GithubCheckStepsParams,
  deps: GithubClientDeps = {},
): Promise<GithubCheckStepsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const target = await resolveGithubPrTarget(params.worktree, deps);
  if (!target.ok) throw new Error(`cannot fetch check steps: ${target.result.state}`);

  const runs = await listWorkflowRunsForSha(
    target.repo,
    target.pr.headSha,
    target.token,
    fetchImpl,
  );
  for (const run of runs) {
    const jobsUrl = `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}/actions/runs/${run.id}/jobs`;
    const jobsData = await githubApiGet<RawJobsResponse>(jobsUrl, target.token, fetchImpl);
    const job = jobsData.jobs.find((j) => j.name === params.checkName);
    if (job) return { steps: (job.steps ?? []).map(mapStep) };
  }
  throw new Error(`no matching Actions job found for check "${params.checkName}"`);
}
