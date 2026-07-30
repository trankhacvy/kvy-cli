import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NewSessionActions } from "../types";
import { performCreateWorkspace, useNewWorkspace } from "../use-new-workspace";

/**
 * `performCreateWorkspace` is the pure orchestration extracted out of
 * `useNewWorkspace` specifically so it's testable without React — this
 * package's vitest has no jsdom, so the hook's own `useEffect`-fed `home`
 * state (the `fs.list` home-directory lookup) never resolves under
 * `renderToStaticMarkup`, the same constraint `use-git-panel.test.ts`'s own
 * header comment documents for a different hook. `useNewWorkspace` itself
 * therefore gets only the deterministic "before anything has resolved"
 * smoke coverage below; every branching-logic assertion lives here instead.
 */
function fakeActions(overrides: Partial<NewSessionActions> = {}): NewSessionActions {
  return {
    browseDirectory: vi.fn(async () => ({ path: "/Users/me", parent: null, entries: [] })),
    createDirectory: vi.fn(async () => {}),
    registerWorkspace: vi.fn(async () => {}),
    spawn: vi.fn(async () => ({ type: "success" as const, sessionId: "sess-1" })),
    listImportCandidates: vi.fn(async () => []),
    listBranches: vi.fn(async () => []),
    getConfig: vi.fn(async () => ({})),
    ...overrides,
  };
}

const request = { provider: "claude-code" as const, permissionMode: "default" as const };

describe("performCreateWorkspace", () => {
  it("calls createDirectory, then registerWorkspace, then spawn, in that order, all with the absolute path", async () => {
    const calls: string[] = [];
    const actions = fakeActions({
      createDirectory: vi.fn(async (path: string) => {
        calls.push(`createDirectory:${path}`);
      }),
      registerWorkspace: vi.fn(async (path: string) => {
        calls.push(`registerWorkspace:${path}`);
      }),
      spawn: vi.fn(async (req) => {
        calls.push(`spawn:${req.directory}`);
        return { type: "success" as const, sessionId: "sess-1" };
      }),
    });

    const result = await performCreateWorkspace(
      actions,
      "/Users/me/falcon-workspaces/my-app",
      request,
      () => {},
    );

    expect(calls).toEqual([
      "createDirectory:/Users/me/falcon-workspaces/my-app",
      "registerWorkspace:/Users/me/falcon-workspaces/my-app",
      "spawn:/Users/me/falcon-workspaces/my-app",
    ]);
    expect(result).toEqual({
      outcome: "success",
      sessionId: "sess-1",
      directory: "/Users/me/falcon-workspaces/my-app",
    });
  });

  it("reports each step via onStep, in order", async () => {
    const steps: string[] = [];
    const actions = fakeActions();

    await performCreateWorkspace(actions, "/Users/me/falcon-workspaces/app", request, (step) =>
      steps.push(step),
    );

    expect(steps).toEqual(["folder", "registering", "starting"]);
  });

  it("rejects (never a false success) when spawn still reports requiresApproval after both resolutions — runSpawnFlow retries exactly once, then throws", async () => {
    const actions = fakeActions({
      spawn: vi.fn(async () => ({
        type: "requiresApproval" as const,
        action: "create-directory" as const,
        directory: "/Users/me/falcon-workspaces/app",
      })),
    });

    await expect(
      performCreateWorkspace(actions, "/Users/me/falcon-workspaces/app", request, () => {}),
    ).rejects.toThrow(/still reported missing|still unregistered/);
  });

  it("propagates a createDirectory failure and never calls registerWorkspace/spawn", async () => {
    const actions = fakeActions({
      createDirectory: vi.fn(async () => {
        throw new Error("fatal: permission denied");
      }),
    });

    await expect(
      performCreateWorkspace(actions, "/Users/me/falcon-workspaces/app", request, () => {}),
    ).rejects.toThrow("fatal: permission denied");
    expect(actions.registerWorkspace).not.toHaveBeenCalled();
    expect(actions.spawn).not.toHaveBeenCalled();
  });

  it("propagates a registerWorkspace failure and never calls spawn", async () => {
    const actions = fakeActions({
      registerWorkspace: vi.fn(async () => {
        throw new Error("failed to acquire workspace registry lock");
      }),
    });

    await expect(
      performCreateWorkspace(actions, "/Users/me/falcon-workspaces/app", request, () => {}),
    ).rejects.toThrow("failed to acquire workspace registry lock");
    expect(actions.spawn).not.toHaveBeenCalled();
  });
});

describe("useNewWorkspace (smoke — see this file's header comment for why deeper coverage lives in performCreateWorkspace above)", () => {
  function renderHook(machineId: string) {
    const queryClient = new QueryClient();
    let captured: ReturnType<typeof useNewWorkspace> | undefined;
    function Harness() {
      captured = useNewWorkspace(machineId);
      return null;
    }
    renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)),
    );
    if (!captured) throw new Error("Harness never rendered");
    return captured;
  }

  it("starts with home:null and phase:idle before the fs.list effect has ever run", () => {
    const hook = renderHook("mach-1");
    expect(hook.home).toBeNull();
    expect(hook.state).toEqual({ phase: "idle" });
  });

  it("create() is a no-op while home is still null — never builds a path off an unknown home", () => {
    const hook = renderHook("mach-1");
    hook.create("my-app", request);
    expect(hook.state).toEqual({ phase: "idle" });
  });
});
