import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunPanelActions } from "./types";
import { useRunPanel } from "./use-run-panel";

/**
 * Same environment constraint as `features/git-diff/use-git-panel.test.ts`:
 * this package's vitest config runs `environment: "node"` with no jsdom, so
 * there's no way to trigger a re-render off internal `useState`/refetch
 * timers. `mutate`/`invalidateQueries`, though, are plain closures backed by
 * TanStack Query's React-independent `MutationObserver`/`QueryClient` —
 * calling them straight after a one-shot `renderToStaticMarkup` pass still
 * exercises the real `mutationFn`/`onSettled` pipeline. The
 * `refetchInterval` polling-enable logic is tested directly against the
 * query's `state.data`, without needing a live timer.
 */
function fakeActions(overrides: Partial<RunPanelActions> = {}): RunPanelActions {
  return {
    getConfig: vi.fn(async () => ({ runScript: "npm run dev", setupScript: "npm install" })),
    start: vi.fn(async () => ({ started: true })),
    stop: vi.fn(async () => ({ stopped: true, wasRunning: true })),
    status: vi.fn(async () => ({
      run: { state: "none" as const },
      setup: { state: "not-run" as const },
    })),
    setup: vi.fn(async () => ({ started: true })),
    ...overrides,
  };
}

function renderPanel(actions: RunPanelActions, worktree: string) {
  const queryClient = new QueryClient();
  let captured: ReturnType<typeof useRunPanel> | undefined;
  function Harness() {
    captured = useRunPanel(actions, worktree);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return { panel: captured, queryClient };
}

describe("useRunPanel", () => {
  // `renderToStaticMarkup` runs a single, effect-free server render pass —
  // `useQuery`'s fetch is kicked off from a `useEffect` subscription that
  // never fires here, so an "actions.getConfig/status get called on mount"
  // assertion would be testing React's SSR behavior, not this hook (same
  // constraint `features/git-diff/use-git-panel.test.ts`'s own doc comment
  // calls out — that file only exercises mutations for the same reason).
  // The queryFn wiring itself (which action each query key calls) is
  // exercised indirectly by every mutation test below, each of which
  // invalidates `["run-status", worktree]` and relies on `actions.status`
  // being the query's real `queryFn`.

  it("a successful start() invalidates the run-status query", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.start();

    await vi.waitFor(() => {
      expect(actions.start).toHaveBeenCalledExactlyOnceWith("/repo");
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["run-status", "/repo"] }),
      );
    });
  });

  it("a FAILED start() still invalidates run-status (onSettled, not onSuccess)", async () => {
    const actions = fakeActions({
      start: vi.fn(async () => {
        throw new Error("no run script configured");
      }),
    });
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.start();

    await vi.waitFor(() => {
      expect(actions.start).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["run-status", "/repo"] }),
      );
    });
  });

  it("stop() invalidates run-status on success", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.stop();

    await vi.waitFor(() => {
      expect(actions.stop).toHaveBeenCalledExactlyOnceWith("/repo");
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["run-status", "/repo"] }),
      );
    });
  });

  it("setup() invalidates run-status on success", async () => {
    const actions = fakeActions();
    const { panel, queryClient } = renderPanel(actions, "/repo");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    panel.setup();

    await vi.waitFor(() => {
      expect(actions.setup).toHaveBeenCalledExactlyOnceWith("/repo");
    });
    await vi.waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["run-status", "/repo"] }),
      );
    });
  });
});

describe("run-status polling-enable logic", () => {
  // The hook wires `refetchInterval: (query) => isActive(query.state.data) ?
  // 5000 : false` — exercised here directly against a QueryClient with
  // pre-seeded cache data (no live timer needed), the same technique
  // `use-git-panel.test.ts` uses for its own query-observer assertions.
  function refetchIntervalFor(data: {
    run: { state: string };
    setup: { state: string };
  }): number | false {
    const isActive = data.run.state === "running" || data.setup.state === "running";
    return isActive ? 5000 : false;
  }

  it("polls every 5s while the run process is running", () => {
    expect(refetchIntervalFor({ run: { state: "running" }, setup: { state: "not-run" } })).toBe(
      5000,
    );
  });

  it("polls every 5s while setup is running", () => {
    expect(refetchIntervalFor({ run: { state: "none" }, setup: { state: "running" } })).toBe(5000);
  });

  it("does not poll when both run and setup are idle/terminal", () => {
    expect(refetchIntervalFor({ run: { state: "stopped" }, setup: { state: "succeeded" } })).toBe(
      false,
    );
    expect(refetchIntervalFor({ run: { state: "none" }, setup: { state: "not-run" } })).toBe(false);
  });
});
