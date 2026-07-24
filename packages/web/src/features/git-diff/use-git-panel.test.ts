import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GitDiffActions } from "./types";
import { useGitPanel } from "./use-git-panel";

/**
 * `useGitPanel` mixes `useQuery`/`useMutation` — this package's vitest
 * config runs `environment: "node"` with no jsdom/`@testing-library/react`
 * wired up, so there's no way to trigger a real re-render off internal
 * `useState` (see `use-session-lifecycle.test.ts`'s own note on the same
 * constraint). `mutate`/`invalidateQueries`, though, are plain closures
 * backed by TanStack Query's React-independent `MutationObserver`/
 * `QueryClient` — calling them straight after a one-shot
 * `renderToStaticMarkup` pass still exercises the real `mutationFn`/
 * `onSuccess` pipeline. The `compareRef` → new `baseRef` derivation this
 * hook feeds into its `git-diff` queryFn is covered directly, without any
 * rendering, by `git-diff-query.test.ts`'s `buildDiffFetchOptions` tests —
 * a full interactive "change compareRef, observe the refetch" test needs a
 * real DOM this package doesn't have wired up.
 */
function fakeActions(overrides: Partial<GitDiffActions> = {}): GitDiffActions {
  return {
    fetchStatus: vi.fn(async () => ({ branch: "main", ahead: 0, behind: 0, files: [] })),
    fetchDiff: vi.fn(async () => ({ inline: "", truncated: false })),
    commit: vi.fn(async () => ({ committed: true, commitSha: "abc1234" })),
    push: vi.fn(async () => ({ remote: "origin", branch: "main", forced: false })),
    renameBranch: vi.fn(async () => ({ branch: "renamed", hadUpstream: false })),
    listBranches: vi.fn(async () => []),
    unregisterWorkspace: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function renderPanel(actions: GitDiffActions, worktree: string) {
  const queryClient = new QueryClient();
  let captured: ReturnType<typeof useGitPanel> | undefined;
  function Harness() {
    captured = useGitPanel(actions, worktree);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return { panel: captured, queryClient };
}

describe("useGitPanel", () => {
  it("a successful commit invalidates the git-status and git-diff queries", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.commit({ message: "fix bug", stageAll: true });

    await vi.waitFor(() => {
      expect(actions.commit).toHaveBeenCalledExactlyOnceWith("/repo", "fix bug", {
        stageAll: true,
      });
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-status", "/repo"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-diff", "/repo"] }),
      );
    });
  });

  it("a failed commit does NOT invalidate the git-status/git-diff queries", async () => {
    const actions = fakeActions({
      commit: vi.fn(async () => {
        throw new Error("fatal: unable to write commit object");
      }),
    });
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.commit({ message: "fix bug" });

    await vi.waitFor(() => {
      expect(actions.commit).toHaveBeenCalledOnce();
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a successful push invalidates the git-status query", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.push({ force: true });

    await vi.waitFor(() => {
      expect(actions.push).toHaveBeenCalledExactlyOnceWith("/repo", { force: true });
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-status", "/repo"] }),
      );
    });
  });

  it("a successful renameBranch invalidates git-status, git-diff, AND git-branches", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.renameBranch("renamed");

    await vi.waitFor(() => {
      expect(actions.renameBranch).toHaveBeenCalledExactlyOnceWith("/repo", "renamed");
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-branches", "/repo"] }),
      );
    });
  });
});
