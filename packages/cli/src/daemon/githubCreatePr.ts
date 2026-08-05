import type { GithubCreatePrParams, GithubCreatePrResult } from "@kvy/wire";
import { type GitExec, runGit } from "./gitExec.js";
import {
  type GithubClientDeps,
  githubApiGet,
  githubApiPost,
  mapPullRequest,
  type RawPull,
  resolveGithubTarget,
} from "./githubClient.js";

interface RawRepo {
  default_branch: string;
}

export async function createGithubPr(
  params: GithubCreatePrParams,
  deps: GithubClientDeps & { git?: GitExec } = {},
): Promise<GithubCreatePrResult> {
  const git = deps.git ?? runGit;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const target = await resolveGithubTarget(params.worktree, deps);
  if (!target.ok) throw new Error(`cannot create PR: ${target.result.state}`);

  const repoInfo = await githubApiGet<RawRepo>(
    `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}`,
    target.token,
    fetchImpl,
  );

  const title = (await git(["log", "-1", "--format=%s"], params.worktree)).trim() || target.branch;

  const raw = await githubApiPost<RawPull>(
    `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}/pulls`,
    target.token,
    { title, head: target.branch, base: repoInfo.default_branch },
    fetchImpl,
  );

  return { pr: mapPullRequest(raw) };
}
