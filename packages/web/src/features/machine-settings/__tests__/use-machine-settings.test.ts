import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MachineSettingsActions } from "../types";
import { useMachineSettings } from "../use-machine-settings";

/**
 * `useMachineSettings` mixes `useQuery`/`useMutation` — this package's
 * vitest config runs `environment: "node"` with no jsdom/
 * `@testing-library/react` wired up, so there's no way to trigger a real
 * re-render off internal `useState` (`use-git-panel.test.ts`'s own note on
 * the same constraint). `setMode` is a plain closure backed by TanStack
 * Query's React-independent `MutationObserver`/`QueryClient`, so calling it
 * straight after a one-shot `renderToStaticMarkup` pass still exercises the
 * real `mutationFn`/`onSuccess` (`setQueryData`) pipeline — asserted here
 * directly against the `queryClient`'s cache rather than via a re-rendered
 * `result.current.state`.
 */
function renderSettings(actions: MachineSettingsActions, machineId: string) {
  const queryClient = new QueryClient();
  let captured: ReturnType<typeof useMachineSettings> | undefined;
  function Harness() {
    captured = useMachineSettings(actions, machineId);
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
  );
  if (!captured) throw new Error("Harness never rendered");
  return { settings: captured, queryClient };
}

function fakeActions(overrides: Partial<MachineSettingsActions> = {}): MachineSettingsActions {
  return {
    fetchSleepInhibit: vi.fn(async () => ({
      supported: true,
      platform: "darwin",
      mode: "off" as const,
      active: false,
    })),
    setSleepInhibit: vi.fn(async (mode) => ({
      supported: true,
      platform: "darwin",
      mode,
      active: mode !== "off",
    })),
    ...overrides,
  };
}

describe("useMachineSettings", () => {
  it("setMode writes the mutation's result straight into the query cache via setQueryData", async () => {
    const actions = fakeActions();
    const { settings, queryClient } = renderSettings(actions, "mach-1");

    settings.setMode("always");

    await vi.waitFor(() => {
      expect(actions.setSleepInhibit).toHaveBeenCalledExactlyOnceWith("always");
    });
    await vi.waitFor(() => {
      expect(queryClient.getQueryData(["machine-settings", "sleep-inhibit", "mach-1"])).toEqual({
        supported: true,
        platform: "darwin",
        mode: "always",
        active: true,
      });
    });

    // The mutation's own result IS the fresh state — no follow-up
    // fetchSleepInhibit re-fetch round-trip on success (`onSuccess` calls
    // `setQueryData` directly, never `invalidateQueries`).
    expect(actions.fetchSleepInhibit).not.toHaveBeenCalled();
  });

  it("a failed setSleepInhibit does NOT write anything into the query cache", async () => {
    const actions = fakeActions({
      setSleepInhibit: vi.fn(async () => {
        throw new Error("machine unreachable");
      }),
    });
    const { settings, queryClient } = renderSettings(actions, "mach-1");

    settings.setMode("always");

    await vi.waitFor(() => {
      expect(actions.setSleepInhibit).toHaveBeenCalledOnce();
    });
    expect(
      queryClient.getQueryData(["machine-settings", "sleep-inhibit", "mach-1"]),
    ).toBeUndefined();
  });
});
