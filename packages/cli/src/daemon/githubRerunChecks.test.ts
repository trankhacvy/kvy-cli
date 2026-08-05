import { describe, expect, it, vi } from "vitest";
import type { GithubToken } from "../github/githubAuth.js";
import { rerunGithubChecks } from "./githubRerunChecks.js";

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

describe("rerunGithubChecks", () => {
  it("reruns only the failed workflow runs and reports how many", async () => {
    const post = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({}),
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/pulls")) return pullsResponse();
      if (urlString.includes("/actions/runs?head_sha=")) {
        return jsonResponse({
          workflow_runs: [
            { id: 1, status: "completed", conclusion: "failure" },
            { id: 2, status: "completed", conclusion: "success" },
          ],
        });
      }
      if (urlString.includes("/rerun-failed-jobs")) return post(url, init);
      throw new Error(`fakeFetch: no handler for ${urlString}`);
    });

    const result = await rerunGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });

    expect(result).toEqual({ ok: true, rerunCount: 1 });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      "https://api.github.com/repos/owner/repo/actions/runs/1/rerun-failed-jobs",
      expect.anything(),
    );
  });

  it("reruns nothing when no workflow run failed", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const urlString = String(url);
      if (urlString.includes("/pulls")) return pullsResponse();
      if (urlString.includes("/actions/runs?head_sha=")) {
        return jsonResponse({
          workflow_runs: [{ id: 1, status: "completed", conclusion: "success" }],
        });
      }
      throw new Error(`fakeFetch: no handler for ${urlString}`);
    });

    const result = await rerunGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl });
    expect(result).toEqual({ ok: true, rerunCount: 0 });
  });

  it("throws when there's no open PR for the branch", async () => {
    const fetchImpl = async () => jsonResponse([]);
    await expect(
      rerunGithubChecks(PARAMS, { readToken: () => TOKEN, git, fetchImpl }),
    ).rejects.toThrow(/cannot rerun checks: no-pr/);
  });
});
