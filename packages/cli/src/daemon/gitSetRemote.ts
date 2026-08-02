/**
 * Deliberately additive-only in effect: `git remote add` for a new name,
 * `git remote set-url` for an existing one, and no path at all to
 * `git remote remove`/`rename` — removing a remote is a destructive act
 * with no undo from a phone, and nothing in the web UI needs it.
 *
 * `name` and `url` are both guarded against the leading-`-` argv-injection
 * hazard (a `--config=...`-shaped "url" would otherwise be parsed as a
 * `git remote` option). The URL is NOT validated for scheme, host or
 * reachability: Kvy manages no git credentials, so "does this remote
 * actually work" is answered by the user's own next push, with git's own
 * stderr — not fabricated here.
 */
import type { GitSetRemoteParams, GitSetRemoteResult } from "@kvy/wire";
import { type GitExec, GitExecError, runGit } from "./gitExec.js";
import { createRegistryWorktreeAuthorizer, type WorktreeAuthorizer } from "./gitWriteGuard.js";

export interface GitSetRemoteDeps {
  /** Injectable for tests; defaults to the real `git` binary. */
  git?: GitExec;
  /** Injectable for tests; defaults to the real registered-workspace check (`gitWriteGuard.ts`). */
  authorizeWorktree?: WorktreeAuthorizer;
}

/** Same hazard, and same shape, as `gitPush.ts`'s own `assertSafeRefName` — kept as a local copy so this handler's errors stay a `GitExecError`, matching every other error it can throw. */
function assertSafeArg(kind: "remote name" | "remote url", value: string): void {
  if (value.trim() === "" || value.startsWith("-")) {
    throw new GitExecError(`unsafe ${kind}: ${value}`);
  }
}

/** Returns whether a remote called `name` is already configured. */
async function remoteExists(git: GitExec, worktree: string, name: string): Promise<boolean> {
  const output = await git(["remote"], worktree);
  return output
    .split("\n")
    .map((line) => line.trim())
    .includes(name);
}

/** Adds (or updates the URL of) `params.name` in `params.worktree`. Throws `GitExecError` on an unauthorized worktree, an unsafe name/url, or any `git` failure. */
export async function handleGitSetRemote(
  params: GitSetRemoteParams,
  deps: GitSetRemoteDeps = {},
): Promise<GitSetRemoteResult> {
  const git = deps.git ?? runGit;
  const authorizeWorktree = deps.authorizeWorktree ?? createRegistryWorktreeAuthorizer();

  await authorizeWorktree(params.worktree);

  const name = params.name ?? "origin";
  assertSafeArg("remote name", name);
  assertSafeArg("remote url", params.url);

  const exists = await remoteExists(git, params.worktree, name);
  await git(
    exists ? ["remote", "set-url", name, params.url] : ["remote", "add", name, params.url],
    params.worktree,
  );

  return { ok: true, name, url: params.url, created: !exists };
}
