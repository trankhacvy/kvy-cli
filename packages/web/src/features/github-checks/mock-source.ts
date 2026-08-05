import { useMemo } from "react";
import type { GithubChecksActions, GithubChecksSnapshot, UseGithubChecksActions } from "./types";

/**
 * The Checks tab's default data source — mirrors `features/git-diff/
 * mock-source.ts`'s role: `apiSocket`/a live per-machine crypto client
 * aren't wired into every screen yet, so this simulates the daemon's
 * `github.checks` RPC with one canned fixture per wire `state`, kept to the
 * same call signature (`GithubChecksActions`) so swapping in the real
 * `machineRpcToGithubChecksActions` later is a one-line change at the call
 * site.
 */

const LATENCY_MS = 200;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Every `GithubChecksSnapshot.state` the wire protocol defines, one fixture each — used both by this mock source's default ("ok", the interesting case) and directly by tests exercising every other state (`ChecksPanel`'s render test, `mock-source.test.ts`). */
export const MOCK_GITHUB_CHECKS_FIXTURES: Record<
  GithubChecksSnapshot["state"],
  GithubChecksSnapshot
> = {
  "no-token": { state: "no-token" },
  "unsupported-remote": {
    state: "unsupported-remote",
    message: 'remote "https://gitlab.com/owner/repo.git" isn\'t a github.com repository',
  },
  "not-pushed": { state: "not-pushed", branch: "feature/checks-tab" },
  "no-pr": {
    state: "no-pr",
    branch: "feature/checks-tab",
    repo: { owner: "kvy-dev", name: "kvy" },
  },
  ok: {
    state: "ok",
    repo: { owner: "kvy-dev", name: "kvy" },
    branch: "feature/checks-tab",
    pr: {
      number: 42,
      title: "Add the Checks tab",
      url: "https://github.com/kvy-dev/kvy/pull/42",
      state: "open",
      headSha: "abc1234",
      draft: false,
    },
    checks: [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://github.com/kvy-dev/kvy/actions/runs/1",
        startedAt: 1_700_000_000,
        completedAt: 1_700_000_042,
      },
      {
        name: "typecheck",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/kvy-dev/kvy/actions/runs/2",
        startedAt: 1_700_000_000,
        completedAt: 1_700_000_018,
        summary: "error TS2307: Cannot find module '@kvy/crypto/web'.",
        provider: "github-actions",
      },
      {
        name: "test",
        status: "in_progress",
        startedAt: 1_700_000_000,
      },
      {
        name: "lint",
        status: "queued",
      },
    ],
  },
};

export function createMockGithubChecksActions(
  _machineId: string,
  state: GithubChecksSnapshot["state"] = "ok",
): GithubChecksActions {
  return {
    async fetchChecks(_worktree) {
      await delay(LATENCY_MS);
      return MOCK_GITHUB_CHECKS_FIXTURES[state];
    },
    async fetchCheckSteps(_worktree, _checkName) {
      await delay(LATENCY_MS);
      return [
        { name: "checkout", status: "completed", conclusion: "success", number: 1 },
        { name: "run tests", status: "completed", conclusion: "failure", number: 2 },
      ];
    },
    async rerunChecks(_worktree) {
      await delay(LATENCY_MS);
      return { rerunCount: 1 };
    },
    async cancelChecks(_worktree) {
      await delay(LATENCY_MS);
      return { cancelledCount: 1 };
    },
    async createPr(_worktree) {
      await delay(LATENCY_MS);
      const okFixture = MOCK_GITHUB_CHECKS_FIXTURES.ok;
      if (!okFixture.pr) throw new Error("mock fixture has no pr");
      return okFixture.pr;
    },
  };
}

/** `useMemo`'d on `machineId` so a real hook backed by a live `GithubChecksActions` client (which shouldn't reseal/reconnect every render) can be swapped in without changing this call site's shape. */
export const useMockGithubChecksActions: UseGithubChecksActions = (machineId) =>
  useMemo(() => createMockGithubChecksActions(machineId), [machineId]);
