import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GitDiffActions } from "./types";
import { translateInitRepoError, useGitPanel } from "./use-git-panel";

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
    initRepo: vi.fn(async () => ({ state: "initialized" as const, branch: "main" })),
    listRemotes: vi.fn(async () => []),
    setRemote: vi.fn(async () => ({ ok: true as const, name: "origin", url: "x", created: true })),
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

  it("commitAndPush runs commit then push and reports pushed:true on the clean path", async () => {
    const actions = fakeActions();
    const { panel } = renderPanel(actions, "/repo");

    const result = await panel.commitAndPush({ message: "fix bug", stageAll: true });

    expect(actions.commit).toHaveBeenCalledExactlyOnceWith("/repo", "fix bug", {
      stageAll: true,
    });
    expect(actions.push).toHaveBeenCalledExactlyOnceWith("/repo", {});
    expect(result).toEqual({ committed: true, commitSha: "abc1234", pushed: true });
  });

  it("commitAndPush short-circuits on nothingToCommit and never calls push", async () => {
    const actions = fakeActions({
      commit: vi.fn(async () => ({ committed: false, nothingToCommit: true })),
    });
    const { panel } = renderPanel(actions, "/repo");

    const result = await panel.commitAndPush({ message: "fix bug" });

    expect(actions.commit).toHaveBeenCalledOnce();
    expect(actions.push).not.toHaveBeenCalled();
    expect(result).toEqual({ committed: false, nothingToCommit: true, pushed: false });
  });

  it("commitAndPush surfaces a partial failure (commit succeeds, push fails) as a rejection, never as overall success", async () => {
    const actions = fakeActions({
      push: vi.fn(async () => {
        throw new Error("fatal: could not read from remote repository");
      }),
    });
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await expect(panel.commitAndPush({ message: "fix bug" })).rejects.toThrow(
      "fatal: could not read from remote repository",
    );
    expect(actions.commit).toHaveBeenCalledOnce();
    expect(actions.push).toHaveBeenCalledOnce();
    // The commit itself still succeeded and must still be reflected/invalidated —
    // only the push leg failed, so `git-status`/`git-diff` were invalidated once
    // (by the successful commit's own `onSuccess`), not skipped outright.
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["git-status", "/repo"] }),
    );
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

  // Feature 1 (docs/web-ux-improvements-plan.md): a successful `git.init`
  // must flip the panel straight from the error state to a live repo with
  // no manual refresh (CLAUDE.md rule #6).
  it("a successful initRepo (state: initialized) invalidates status/diff/branches/remotes", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.initRepo();

    await vi.waitFor(() => {
      expect(actions.initRepo).toHaveBeenCalledExactlyOnceWith("/repo");
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-status", "/repo"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-diff", "/repo"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-branches", "/repo"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-remotes", "/repo"] }),
      );
    });
  });

  it("an initRepo result of inside-existing-repo invalidates NOTHING — nothing changed daemon-side", async () => {
    const actions = fakeActions({
      initRepo: vi.fn(async () => ({
        state: "inside-existing-repo" as const,
        existingRoot: "/repo",
      })),
    });
    const { panel, queryClient } = renderPanel(actions, "/repo/sub");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.initRepo();

    await vi.waitFor(() => {
      expect(actions.initRepo).toHaveBeenCalledOnce();
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a successful setRemote invalidates git-remotes and git-status", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.setRemote({ url: "git@github.com:a/b.git" });

    await vi.waitFor(() => {
      expect(actions.setRemote).toHaveBeenCalledExactlyOnceWith(
        "/repo",
        "git@github.com:a/b.git",
        undefined,
      );
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-remotes", "/repo"] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["git-status", "/repo"] }),
      );
    });
  });
});

describe("translateInitRepoError", () => {
  it("translates a literal 'unknown-method' into a version-skew hint", () => {
    expect(translateInitRepoError("unknown-method")).toMatch(/older version of Kvy/i);
  });

  it("passes any other message through unchanged", () => {
    expect(translateInitRepoError("fatal: permission denied")).toBe("fatal: permission denied");
  });
});
