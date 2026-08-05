import { describe, expect, it } from "vitest";
import type { GithubToken } from "../github/githubAuth.js";
import { getGithubCheckSteps } from "./githubCheckSteps.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo", checkName: "build" };

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

function fakeGit(handlers: Partial<Record<string, (args: string[]) => string>>) {
  return async (args: string[]) => {
    const handler = handlers[args[0] as string];
    if (!handler) throw new Error(`fakeGit: no handler for ${args.join(" ")}`);
    return handler(args);
  };
}

function fakeFetch(handlers: { match: string; response: () => Response }[]) {
  return async (url: string | URL | Request) => {
    const found = handlers.find((h) => String(url).includes(h.match));
    if (!found) throw new Error(`fakeFetch: no handler for ${String(url)}`);
    return found.response();
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

describe("getGithubCheckSteps", () => {
  it("finds the matching job across workflow runs and maps its steps", async () => {
    const fetchImpl = fakeFetch([
      { match: "/pulls", response: pullsResponse },
      {
        match: "/actions/runs?head_sha=",
        response: () =>
          jsonResponse({ workflow_runs: [{ id: 1, status: "completed", conclusion: "failure" }] }),
      },
      {
        match: "/actions/runs/1/jobs",
        response: () =>
          jsonResponse({
            jobs: [
              {
                name: "build",
                steps: [
                  {
                    name: "checkout",
                    status: "completed",
                    conclusion: "success",
                    number: 1,
                    started_at: "2024-01-01T00:00:00Z",
                    completed_at: "2024-01-01T00:00:05Z",
                  },
                  {
                    name: "run tests",
                    status: "completed",
                    conclusion: "failure",
                    number: 2,
                    started_at: "2024-01-01T00:00:05Z",
                    completed_at: "2024-01-01T00:00:20Z",
                  },
                ],
              },
            ],
          }),
      },
    ]);

    const result = await getGithubCheckSteps(PARAMS, { readToken: () => TOKEN, git, fetchImpl });

    expect(result).toEqual({
      steps: [
        {
          name: "checkout",
          status: "completed",
          conclusion: "success",
          number: 1,
          startedAt: 1_704_067_200,
          completedAt: 1_704_067_205,
        },
        {
          name: "run tests",
          status: "completed",
          conclusion: "failure",
          number: 2,
          startedAt: 1_704_067_205,
          completedAt: 1_704_067_220,
        },
      ],
    });
  });

  it("walks a second workflow run when the job isn't in the first", async () => {
    const fetchImpl = fakeFetch([
      { match: "/pulls", response: pullsResponse },
      {
        match: "/actions/runs?head_sha=",
        response: () =>
          jsonResponse({
            workflow_runs: [
              { id: 1, status: "completed", conclusion: "success" },
              { id: 2, status: "completed", conclusion: "failure" },
            ],
          }),
      },
      {
        match: "/actions/runs/1/jobs",
        response: () => jsonResponse({ jobs: [{ name: "lint", steps: [] }] }),
      },
      {
        match: "/actions/runs/2/jobs",
        response: () => jsonResponse({ jobs: [{ name: "build", steps: [] }] }),
      },
    ]);

    const result = await getGithubCheckSteps(PARAMS, { readToken: () => TOKEN, git, fetchImpl });
    expect(result).toEqual({ steps: [] });
  });

  it("throws when no run's jobs match the check name", async () => {
    const fetchImpl = fakeFetch([
      { match: "/pulls", response: pullsResponse },
      {
        match: "/actions/runs?head_sha=",
        response: () =>
          jsonResponse({ workflow_runs: [{ id: 1, status: "completed", conclusion: "success" }] }),
      },
      {
        match: "/actions/runs/1/jobs",
        response: () => jsonResponse({ jobs: [{ name: "lint", steps: [] }] }),
      },
    ]);

    await expect(
      getGithubCheckSteps(PARAMS, { readToken: () => TOKEN, git, fetchImpl }),
    ).rejects.toThrow(/no matching Actions job/);
  });

  it("throws when there's no open PR for the branch", async () => {
    const fetchImpl = fakeFetch([{ match: "/pulls", response: () => jsonResponse([]) }]);

    await expect(
      getGithubCheckSteps(PARAMS, { readToken: () => TOKEN, git, fetchImpl }),
    ).rejects.toThrow(/cannot fetch check steps: no-pr/);
  });
});
