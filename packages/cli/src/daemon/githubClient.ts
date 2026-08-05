import type { GithubChecksResult, PullRequestInfo } from "@kvy/wire";
import { readGithubToken } from "../github/githubAuth.js";
import { readWorkspaceGitConfig } from "../workspaceConfig.js";
import { type GitExec, runGit } from "./gitExec.js";
import { parseGithubRemote } from "./githubChecks.js";

export interface GithubClientDeps {
  git?: GitExec;
  fetchImpl?: typeof fetch;
  readToken?: () => ReturnType<typeof readGithubToken>;
  getWorkspaceRemote?: (worktree: string) => Promise<string | undefined>;
}

export type GithubTarget =
  | { ok: true; token: string; repo: { owner: string; name: string }; branch: string }
  | { ok: false; result: GithubChecksResult };

export async function resolveGithubTarget(
  worktree: string,
  deps: GithubClientDeps = {},
): Promise<GithubTarget> {
  const git = deps.git ?? runGit;
  const readToken = deps.readToken ?? readGithubToken;
  const getWorkspaceRemote =
    deps.getWorkspaceRemote ?? (async (wt: string) => (await readWorkspaceGitConfig(wt))?.remote);

  const token = readToken();
  if (!token) return { ok: false, result: { state: "no-token" } };

  const remoteName = (await getWorkspaceRemote(worktree)) ?? "origin";
  let remoteUrl: string;
  try {
    remoteUrl = (await git(["remote", "get-url", remoteName], worktree)).trim();
  } catch {
    return {
      ok: false,
      result: {
        state: "unsupported-remote",
        message: `no git remote named "${remoteName}" in this worktree`,
      },
    };
  }

  const repo = parseGithubRemote(remoteUrl);
  if (!repo) {
    return {
      ok: false,
      result: {
        state: "unsupported-remote",
        message: `remote "${remoteUrl}" isn't a github.com repository`,
      },
    };
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim();
  if (branch === "HEAD") {
    return {
      ok: false,
      result: { state: "unsupported-remote", message: "detached HEAD has no branch to check" },
    };
  }

  return { ok: true, token: token.token, repo, branch };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function githubApiGet<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`GitHub API request failed: HTTP ${response.status} (${url})`);
  return (await response.json()) as T;
}

export async function githubApiPost<T>(
  url: string,
  token: string,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub API request failed: HTTP ${response.status} (${url}) ${text}`);
  }
  return (await response.json()) as T;
}

interface RawPull {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  draft?: boolean;
  head: { sha: string };
}

function mapPullRequest(raw: RawPull): PullRequestInfo {
  const state: PullRequestInfo["state"] =
    raw.state === "closed" ? (raw.merged_at ? "merged" : "closed") : "open";
  const pr: PullRequestInfo = {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    state,
    headSha: raw.head.sha,
  };
  if (raw.draft !== undefined) pr.draft = raw.draft;
  return pr;
}

export type GithubPrTarget =
  | {
      ok: true;
      token: string;
      repo: { owner: string; name: string };
      branch: string;
      pr: PullRequestInfo;
    }
  | { ok: false; result: GithubChecksResult };

export async function resolveGithubPrTarget(
  worktree: string,
  deps: GithubClientDeps = {},
): Promise<GithubPrTarget> {
  const target = await resolveGithubTarget(worktree, deps);
  if (!target.ok) return target;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const pullsUrl = `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}/pulls?head=${encodeURIComponent(`${target.repo.owner}:${target.branch}`)}&state=open`;
  const pulls = await githubApiGet<RawPull[]>(pullsUrl, target.token, fetchImpl);
  if (pulls.length === 0) {
    return { ok: false, result: { state: "no-pr", branch: target.branch, repo: target.repo } };
  }
  return {
    ok: true,
    token: target.token,
    repo: target.repo,
    branch: target.branch,
    pr: mapPullRequest(pulls[0] as RawPull),
  };
}

export interface RawWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
}

interface RawWorkflowRunsResponse {
  workflow_runs: RawWorkflowRun[];
}

export async function listWorkflowRunsForSha(
  repo: { owner: string; name: string },
  headSha: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<RawWorkflowRun[]> {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs?head_sha=${headSha}`;
  const data = await githubApiGet<RawWorkflowRunsResponse>(url, token, fetchImpl);
  return data.workflow_runs ?? [];
}
