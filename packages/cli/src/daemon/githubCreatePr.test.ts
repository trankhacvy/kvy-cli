import { describe, expect, it } from "vitest";
import type { GithubToken } from "../github/githubAuth.js";
import { createGithubPr } from "./githubCreatePr.js";

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
  log: () => "Add feature x\n",
});

describe("createGithubPr", () => {
  it("opens a PR titled from the branch's latest commit subject, against the default branch", async () => {
    const fetchImpl = fakeFetch([
      {
        match: "api.github.com/repos/owner/repo",
        response: () => jsonResponse({ default_branch: "main" }),
      },
    ]);
    const postFetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/pulls") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string; head: string; base: string };
        expect(body).toEqual({ title: "Add feature x", head: "feature/x", base: "main" });
        return jsonResponse({
          number: 7,
          title: body.title,
          html_url: "https://github.com/owner/repo/pull/7",
          state: "open",
          merged_at: null,
          draft: false,
          head: { sha: "sha456" },
        });
      }
      return fetchImpl(url);
    };

    const result = await createGithubPr(PARAMS, {
      readToken: () => TOKEN,
      git,
      fetchImpl: postFetchImpl,
    });

    expect(result).toEqual({
      pr: {
        number: 7,
        title: "Add feature x",
        url: "https://github.com/owner/repo/pull/7",
        state: "open",
        headSha: "sha456",
        draft: false,
      },
    });
  });

  it("falls back to the branch name when the latest commit has no subject", async () => {
    const gitEmptySubject = fakeGit({
      remote: () => "https://github.com/owner/repo.git\n",
      "rev-parse": () => "feature/x\n",
      log: () => "\n",
    });
    const postFetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      if (
        String(url).includes("api.github.com/repos/owner/repo") &&
        !String(url).includes("/pulls")
      ) {
        return jsonResponse({ default_branch: "main" });
      }
      if (String(url).endsWith("/pulls") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { title: string };
        expect(body.title).toBe("feature/x");
        return jsonResponse({
          number: 8,
          title: body.title,
          html_url: "https://github.com/owner/repo/pull/8",
          state: "open",
          merged_at: null,
          head: { sha: "sha789" },
        });
      }
      throw new Error(`fakeFetch: no handler for ${String(url)}`);
    };

    await createGithubPr(PARAMS, {
      readToken: () => TOKEN,
      git: gitEmptySubject,
      fetchImpl: postFetchImpl,
    });
  });

  it("throws when there's no token", async () => {
    await expect(createGithubPr(PARAMS, { readToken: () => null, git })).rejects.toThrow(
      /cannot create PR: no-token/,
    );
  });
});
