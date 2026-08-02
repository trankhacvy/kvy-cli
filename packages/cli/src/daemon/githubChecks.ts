/**
 * github-pr-ci.md "GitHub PR/CI integration", docs/competitive-notes-
 * omnara.md #4). Backs the web "Checks" tab: resolves the workspace's
 * remote → owner/repo, the current branch, the open PR for that branch
 * head, and the PR head commit's check-runs — authenticated with a
 * machine-local GitHub token (`../github/githubAuth.js`) that never
 *
 * Modeled on `gitStatus.ts`/`gitBranches.ts`'s injectable-deps shape: same
 * `git?: GitExec` seam (defaulting to `gitExec.ts`'s real `runGit`), same
 * "throw through, no silent empty-result fallback" contract for anything
 * that isn't one of the wire's own explicit `GithubChecksResult.state`
 * values (design principle #3 — every empty state is derived here, never
 * stored).
 *
 * The token value is read fresh on every call (`deps.readToken`, default
 * `githubAuth.ts`'s `readGithubToken`) — never cached across calls — so a
 * `kvy github login` run while the daemon is already up takes effect on
 * this RPC's very next call, no daemon restart needed. It is passed only
 * into the `Authorization` header below and is never logged or included in
 * the returned `GithubChecksResult` (verified by githubChecks.test.ts).
 */
import type { CheckRun, GithubChecksParams, GithubChecksResult, PullRequestInfo } from "@kvy/wire";
import { readGithubToken } from "../github/githubAuth.js";
import { readWorkspaceGitConfig } from "../workspaceConfig.js";
import { type GitExec, runGit } from "./gitExec.js";

export interface GithubChecksDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `githubAuth.ts`'s real `readGithubToken` (read fresh per call — see this module's doc comment). */
  readToken?: () => ReturnType<typeof readGithubToken>;
  /** Resolves the workspace's configured git remote name (`workspaceConfig.ts`'s `--remote`, same precedent as `gitDiff.ts`'s `resolveConfiguredBaseRef`); `undefined` falls back to `"origin"`. Injectable for tests. */
  getWorkspaceRemote?: (worktree: string) => Promise<string | undefined>;
}

async function defaultGetWorkspaceRemote(worktree: string): Promise<string | undefined> {
  const config = await readWorkspaceGitConfig(worktree);
  return config?.remote;
}

/**
 * Parses a git remote URL into `{owner, name}` for github.com repositories
 * only — handles the scp-like syntax (`git@github.com:owner/repo.git`),
 * `ssh://git@github.com/owner/repo.git`, and `https://github.com/owner/repo`
 * (`.git`-suffixed or not). Any other host — including a GitHub Enterprise
 * instance — returns `null` for MVP (docs/features/github-pr-ci.md: "any
 * non-github.com host ... returns null").
 */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const trimmed = url.trim();

  const scpMatch = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (scpMatch) {
    const [, host, pathPart] = scpMatch as unknown as [string, string, string];
    if (host !== "github.com") return null;
    return parseOwnerRepo(pathPart);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") return null;
    return parseOwnerRepo(parsed.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

function parseOwnerRepo(pathPart: string): { owner: string; name: string } | null {
  const cleaned = pathPart.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[segments.length - 2];
  const name = segments[segments.length - 1];
  if (!owner || !name) return null;
  return { owner, name };
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

interface RawCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface RawCheckRunsResponse {
  check_runs: RawCheckRun[];
}

/** ISO 8601 → unix seconds, matching `GitBranchInfoSchema`'s `lastCommitAt` precedent; `undefined` for a null/unparseable timestamp rather than `NaN`/`0`. */
function toUnixSeconds(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function mapCheckRun(raw: RawCheckRun): CheckRun {
  const run: CheckRun = { name: raw.name, status: raw.status };
  if (raw.conclusion) run.conclusion = raw.conclusion as CheckRun["conclusion"];
  if (raw.details_url) run.detailsUrl = raw.details_url;
  const startedAt = toUnixSeconds(raw.started_at);
  if (startedAt !== undefined) run.startedAt = startedAt;
  const completedAt = toUnixSeconds(raw.completed_at);
  if (completedAt !== undefined) run.completedAt = completedAt;
  return run;
}

interface GithubApiResult {
  /** `true` when GitHub answered 401 — the stored token was rejected. Never set alongside `data`. */
  unauthorized: boolean;
  data: unknown;
}

/** GETs a GitHub REST API URL with the standard auth headers. A 401 is reported back as `{unauthorized: true}` (mapped to `GithubChecksResult`'s `"no-token"` state by the caller) rather than thrown; any other non-2xx (including a 403 rate-limit) throws, letting `machineRpc.ts`'s uniform sealed-error path answer — this handler never fabricates an empty success for an API error it doesn't understand. */
async function githubApiGet(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<GithubApiResult> {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 401) return { unauthorized: true, data: undefined };
  if (!response.ok) {
    throw new Error(`GitHub API request failed: HTTP ${response.status} (${url})`);
  }
  return { unauthorized: false, data: await response.json() };
}

/**
 * Resolves the PR/CI check state for the current branch of `params.worktree`.
 * Never throws for an expected "nothing to show yet" case — those are all
 * distinct `GithubChecksResult.state` values (`no-token`/`unsupported-remote`/
 * `not-pushed`/`no-pr`), each carrying enough context for the web panel's
 * derived empty-state copy. Throws (a plain `Error`, or `GitExecError` from
 * `git` itself) only for a genuine unexpected failure — a `git` invocation
 * failing for a reason other than "no such remote", or a GitHub API error
 * this handler doesn't have a defined state for.
 */
export async function getGithubChecks(
  params: GithubChecksParams,
  deps: GithubChecksDeps = {},
): Promise<GithubChecksResult> {
  const git = deps.git ?? runGit;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readToken = deps.readToken ?? readGithubToken;
  const getWorkspaceRemote = deps.getWorkspaceRemote ?? defaultGetWorkspaceRemote;

  const token = readToken();
  if (!token) return { state: "no-token" };

  const remoteName = (await getWorkspaceRemote(params.worktree)) ?? "origin";

  let remoteUrl: string;
  try {
    remoteUrl = (await git(["remote", "get-url", remoteName], params.worktree)).trim();
  } catch {
    return {
      state: "unsupported-remote",
      message: `no git remote named "${remoteName}" in this worktree`,
    };
  }

  const repo = parseGithubRemote(remoteUrl);
  if (!repo) {
    return {
      state: "unsupported-remote",
      message: `remote "${remoteUrl}" isn't a github.com repository`,
    };
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], params.worktree)).trim();
  if (branch === "HEAD") {
    return { state: "unsupported-remote", message: "detached HEAD has no branch to check" };
  }

  const pullsUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?head=${encodeURIComponent(`${repo.owner}:${branch}`)}&state=open`;
  const pullsResponse = await githubApiGet(pullsUrl, token.token, fetchImpl);
  if (pullsResponse.unauthorized) {
    return { state: "no-token", message: "stored token was rejected" };
  }

  const pulls = pullsResponse.data as RawPull[];
  if (pulls.length === 0) {
    // Fork-workflow PRs (head owner ≠ base owner) are out of scope for MVP —
    // `head={owner}:{branch}` above assumes the branch lives in this same
    // repo, so a fork's PR simply won't be found here; this falls through to
    // an honest "no-pr" rather than a wrong match.
    const lsRemoteOutput = await git(["ls-remote", "--heads", remoteName, branch], params.worktree);
    if (lsRemoteOutput.trim() === "") {
      return { state: "not-pushed", branch };
    }
    return { state: "no-pr", branch, repo };
  }

  const pr = mapPullRequest(pulls[0] as RawPull);

  const checksUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${pr.headSha}/check-runs?per_page=100`;
  const checksResponse = await githubApiGet(checksUrl, token.token, fetchImpl);
  if (checksResponse.unauthorized) {
    return { state: "no-token", message: "stored token was rejected" };
  }

  const checks = ((checksResponse.data as RawCheckRunsResponse).check_runs ?? []).map(mapCheckRun);

  return { state: "ok", repo, branch, pr, checks };
}
