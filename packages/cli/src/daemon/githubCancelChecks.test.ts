import { describe, expect, it, vi } from "vitest";
import type { GithubToken } from "../github/githubAuth.js";
import { cancelGithubChecks } from "./githubCancelChecks.js";

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
    text: async () => JSON.stringify(body),
  } as Response;
}

function fakeGit(handlers: Partial<Record<string, (args: string[]) => string>>) {
  return async (args: string[]) => {
    const handler = handlers[args[0] as string];
    if (!handler) throw new Error(`fakeGit: no handler for ${args.join(" ")}`);
    return handler(args);
  };
}

const git = fakeGit({
  remote: () => "https://github.com/owner/repo.git\n",
  "rev-parse": () => "feature/x\n",
});

const pullsResponse = () =>
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
  ]);

describe("cancelGithubChecks", () => {
  it("cancels only the still-running workflow runs and reports how many", async () => {
    const post = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({}),
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/pulls")) return pullsResponse();
      if (urlString.includes("/actions/runs?head_sha=")) {
        return jsonResponse({
          workflow_runs: [
            { id: 1, status: "in_progress", conclusion: null },
            { id: 2, status: "queued", conclusion: null },
            { id: 3, status: "completed", conclusion: "success" },
          ],
        });
      }
      if (urlString.includes("/cancel")) return post(url, init);
      throw new Error(`fakeFetch: no handler for ${urlString}`);
    });

    const result = await cancelGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });

    expect(result).toEqual({ ok: true, cancelledCount: 2 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("throws when there's no open PR for the branch", async () => {
    const fetchImpl = async () => jsonResponse([]);
    await expect(
      cancelGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl }),
    ).rejects.toThrow(/cannot cancel checks: no-pr/);
  });
});
