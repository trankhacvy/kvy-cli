import { describe, expect, it, vi } from "vitest";
import type { GithubToken } from "../github/githubAuth.js";
import { getGithubChecks, parseGithubRemote } from "./githubChecks.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

const TOKEN: GithubToken = {
  token: "gho_supersecrettoken",
  createdAt: 1000,
  scope: "repo",
  method: "pat",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Dispatches `git <args>` calls by matching the first argument, mirroring `gitBranches.test.ts`'s fake-git style but with per-subcommand behavior since `getGithubChecks` calls `git` multiple times per run. */
function fakeGit(handlers: Partial<Record<string, (args: string[]) => string>>) {
  return vi.fn(async (args: string[]) => {
    const handler = handlers[args[0] as string];
    if (!handler) throw new Error(`fakeGit: no handler for ${args.join(" ")}`);
    return handler(args);
  });
}

/** Dispatches fetch calls by matching a substring of the URL — real calls only ever pass a plain string URL here. */
function fakeFetch(handlers: { match: string; response: () => Response }[]) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const found = handlers.find((h) => String(url).includes(h.match));
    if (!found) throw new Error(`fakeFetch: no handler for ${String(url)}`);
    return found.response();
  });
}

describe("parseGithubRemote", () => {
  it("parses the scp-like syntax (git@github.com:owner/repo.git)", () => {
    expect(parseGithubRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses ssh://git@github.com/owner/repo.git", () => {
    expect(parseGithubRemote("ssh://git@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses https://github.com/owner/repo (no .git suffix)", () => {
    expect(parseGithubRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("parses https://github.com/owner/repo.git", () => {
    expect(parseGithubRemote("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  it("rejects a GitHub Enterprise host (scp-like syntax)", () => {
    expect(parseGithubRemote("git@github.enterprise.internal:owner/repo.git")).toBeNull();
  });

  it("rejects a GitHub Enterprise host (https)", () => {
    expect(parseGithubRemote("https://github.enterprise.internal/owner/repo")).toBeNull();
  });

  it("rejects a non-github, non-URL string", () => {
    expect(parseGithubRemote("not a remote url")).toBeNull();
  });

  it("rejects a path with fewer than two segments", () => {
    expect(parseGithubRemote("https://github.com/owner")).toBeNull();
  });
});

describe("getGithubChecks", () => {
  it("returns no-token when readToken resolves null", async () => {
    const result = await getGithubChecks(PARAMS, { readToken: () => null });
    expect(result).toEqual({ state: "no-token" });
  });

  it("returns unsupported-remote when the configured remote doesn't exist", async () => {
    const git = fakeGit({
      remote: () => {
        throw new Error("fatal: No such remote 'origin'");
      },
    });
    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git });
    expect(result.state).toBe("unsupported-remote");
  });

  it("returns unsupported-remote when the remote isn't a github.com repo", async () => {
    const git = fakeGit({
      remote: () => "https://gitlab.com/owner/repo.git\n",
    });
    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git });
    expect(result.state).toBe("unsupported-remote");
    expect(result.message).toBeDefined();
  });

  it("returns unsupported-remote for a detached HEAD", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "HEAD\n",
    });
    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git });
    expect(result).toEqual({ state: "unsupported-remote", message: expect.any(String) });
  });

  it("returns not-pushed when the branch has no open PR and isn't on the remote", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
      "ls-remote": () => "",
    });
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse([]) }]);
    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });
    expect(result).toEqual({ state: "not-pushed", branch: "feature/x" });
  });

  it("returns no-pr when the branch is pushed but has no open PR", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
      "ls-remote": () => "abc123\trefs/heads/feature/x\n",
    });
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse([]) }]);
    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });
    expect(result).toEqual({
      state: "no-pr",
      branch: "feature/x",
      repo: { owner: "owner", name: "repo" },
    });
  });

  it("returns ok with the PR and mapped check-runs (ISO timestamps → unix seconds)", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
    });
    const fetchImpl = fakeFetch([
      {
        match: "/pulls",
        response: () =>
          jsonResponse([
            {
              number: 42,
              title: "Add feature x",
              html_url: "https://github.com/owner/repo/pull/42",
              state: "open",
              merged_at: null,
              draft: false,
              head: { sha: "sha123" },
            },
          ]),
      },
      {
        match: "/check-runs",
        response: () =>
          jsonResponse({
            check_runs: [
              {
                name: "build",
                status: "completed",
                conclusion: "success",
                details_url: "https://ci.example.com/build",
                started_at: "2024-01-01T00:00:00Z",
                completed_at: "2024-01-01T00:01:00Z",
                output: null,
                app: { slug: "github-actions" },
              },
              {
                name: "test",
                status: "in_progress",
                conclusion: null,
                details_url: null,
                started_at: "2024-01-01T00:00:30Z",
                completed_at: null,
                output: { summary: "still running" },
                app: { slug: "vercel" },
              },
            ],
          }),
      },
    ]);

    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });

    expect(result).toEqual({
      state: "ok",
      repo: { owner: "owner", name: "repo" },
      branch: "feature/x",
      pr: {
        number: 42,
        title: "Add feature x",
        url: "https://github.com/owner/repo/pull/42",
        state: "open",
        headSha: "sha123",
        draft: false,
      },
      checks: [
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://ci.example.com/build",
          startedAt: 1_704_067_200,
          completedAt: 1_704_067_260,
          provider: "github-actions",
        },
        {
          name: "test",
          status: "in_progress",
          startedAt: 1_704_067_230,
          summary: "still running",
          provider: "other",
        },
      ],
    });
  });

  it("maps a merged, closed PR to state: merged", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
    });
    const fetchImpl = fakeFetch([
      {
        match: "/pulls",
        response: () =>
          jsonResponse([
            {
              number: 7,
              title: "Merged feature",
              html_url: "https://github.com/owner/repo/pull/7",
              state: "closed",
              merged_at: "2024-01-02T00:00:00Z",
              head: { sha: "shaZZZ" },
            },
          ]),
      },
      { match: "/check-runs", response: () => jsonResponse({ check_runs: [] }) },
    ]);

    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });
    expect(result.pr?.state).toBe("merged");
  });

  it("returns no-token when the pulls request is rejected with 401", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
    });
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse({}, 401) }]);

    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });
    expect(result).toEqual({ state: "no-token", message: expect.any(String) });
  });

  it("throws on a non-401 GitHub API error (e.g. 500) rather than returning an empty success", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
    });
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse({}, 500) }]);

    await expect(
      getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl }),
    ).rejects.toThrow(/500/);
  });

  it("throws on a 403 rate-limit response", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
    });
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse({}, 403) }]);

    await expect(
      getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl }),
    ).rejects.toThrow(/403/);
  });

  it("sends the token in the Authorization header but never leaks it into the returned result", async () => {
    const git = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
    });
    const fetchImpl = fakeFetch([
      {
        match: "/pulls",
        response: () =>
          jsonResponse([
            {
              number: 1,
              title: "t",
              html_url: "https://github.com/owner/repo/pull/1",
              state: "open",
              merged_at: null,
              head: { sha: "sha1" },
            },
          ]),
      },
      { match: "/check-runs", response: () => jsonResponse({ check_runs: [] }) },
    ]);

    const result = await getGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN.token}`);
    }
    expect(JSON.stringify(result)).not.toContain(TOKEN.token);
  });

  it("uses the workspace's configured remote name instead of origin when getWorkspaceRemote resolves one", async () => {
    const git = fakeGit({
      remote: (args) => {
        expect(args).toEqual(["remote", "get-url", "upstream"]);
        return "https://github.com/owner/repo.git\n";
      },
      "rev-parse": () => "feature/x\n",
      "ls-remote": (args) => {
        expect(args).toContain("upstream");
        return "";
      },
    });
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse([]) }]);

    const result = await getGithubChecks(PARAMS, {
      readToken: () => TOKEN,
      git,
      fetchImpl,
      getWorkspaceRemote: async () => "upstream",
    });

    expect(result).toEqual({ state: "not-pushed", branch: "feature/x" });
  });
});
