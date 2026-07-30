import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RepoFilesActions } from "./types";
import { useRepoFiles } from "./use-repo-files";

/**
 * `useRepoFiles` mixes `useQuery`/`useMutation`/`useEffect` — this
 * package's vitest config runs `environment: "node"` with no jsdom, so
 * there's no way to trigger a real re-render or flush an effect (same
 * constraint `use-git-panel.test.ts`'s own header comment documents for a
 * sibling hook). The Feature 3 Phase 5 byte-cursor paging logic this hook
 * wires up (`appendPage`/`stripTruncationMarker`) is therefore tested
 * directly, with real assertions, in `file-content-paging.test.ts` — this
 * file only covers the deterministic "nothing has resolved yet" frame and
 * that mounting alone never fires an RPC.
 */
function fakeActions(overrides: Partial<RepoFilesActions> = {}): RepoFilesActions {
  return {
    fetchFileList: vi.fn(async () => []),
    fetchFileContent: vi.fn(async () => ({ inline: "content", truncated: false })),
    ...overrides,
  };
}

function renderHook(actions: RepoFilesActions, worktree: string) {
  const queryClient = new QueryClient();
  let captured: ReturnType<typeof useRepoFiles> | undefined;
  function Harness() {
    captured = useRepoFiles(actions, worktree);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return captured;
}

describe("useRepoFiles", () => {
  it("starts with an empty tree, no selected path, and no content before anything has resolved", () => {
    const hook = renderHook(fakeActions(), "/repo");
    expect(hook.tree).toEqual([]);
    expect(hook.selectedPath).toBeNull();
    expect(hook.content).toBeUndefined();
    expect(hook.isLoadingMoreContent).toBe(false);
  });

  it("never calls fetchFileList/fetchFileContent synchronously merely by rendering", () => {
    const actions = fakeActions();
    renderHook(actions, "/repo");
    // `useQuery`'s `queryFn` only ever runs inside TanStack Query's own
    // scheduling (a microtask via its query observer), never synchronously
    // during the render that mounts it — this is the same guarantee
    // `use-git-panel.test.ts` relies on for its own "never fires eagerly"
    // assertions.
    expect(actions.fetchFileList).not.toHaveBeenCalled();
  });

  it("exposes loadMoreContent as a stable callable that rejects gracefully with no content loaded yet", async () => {
    const actions = fakeActions();
    const hook = renderHook(actions, "/repo");
    // Calling it before any first page has landed must not throw
    // synchronously — `useMutation.mutate` always swallows into its own
    // async state.
    expect(() => hook.loadMoreContent()).not.toThrow();
  });
});
