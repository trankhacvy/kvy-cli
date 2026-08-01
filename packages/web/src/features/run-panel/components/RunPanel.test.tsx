import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UseRunPanelActions } from "../types";
import { RunPanel, RunPanelBody } from "./RunPanel";

function renderBody(props: Parameters<typeof RunPanelBody>[0]): string {
  return renderToStaticMarkup(createElement(RunPanelBody, props));
}

function baseProps(overrides: Partial<Parameters<typeof RunPanelBody>[0]> = {}) {
  return {
    config: { runScript: "npm run dev", setupScript: "npm install" },
    isConfigLoading: false,
    status: { run: { state: "none" as const }, setup: { state: "not-run" as const } },
    isStatusLoading: false,
    statusError: null,
    onStart: () => {},
    isStartPending: false,
    startError: null,
    onStop: () => {},
    isStopPending: false,
    stopError: null,
    onSetup: () => {},
    isSetupPending: false,
    setupError: null,
    ...overrides,
  };
}

describe("RunPanelBody", () => {
  it("shows a loading message while config/status are loading", () => {
    expect(renderBody(baseProps({ isConfigLoading: true }))).toContain("Loading run panel");
  });

  it("shows a status error message", () => {
    const html = renderBody(baseProps({ statusError: "unreachable" }));
    expect(html).toContain("Could not load run status");
    expect(html).toContain("unreachable");
  });

  it("no run script configured — Play is disabled with the terminal-command hint", () => {
    const html = renderBody(
      baseProps({ config: { runScript: undefined, setupScript: "npm install" } }),
    );
    expect(html).toContain("No run script configured");
    expect(html).toContain("kvy workspace config --run-script");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Play/);
  });

  it("running — shows the Running badge, a Stop button, and the run log tail", () => {
    const html = renderBody(
      baseProps({
        status: {
          run: {
            state: "running",
            pid: 4242,
            method: "tmux",
            startedAt: 1,
            logTail: "Server listening on http://localhost:3000\n",
          },
          setup: { state: "not-run" },
        },
      }),
    );
    expect(html).toContain("Running");
    expect(html).toContain("Stop");
    expect(html).toContain("Server listening on http://localhost:3000");
  });

  it("setup failed — shows the Failed badge, exit code, and the setup log tail", () => {
    const html = renderBody(
      baseProps({
        status: {
          run: { state: "none" },
          setup: {
            state: "failed",
            exitCode: 1,
            startedAt: 1,
            finishedAt: 2,
            logTail: "npm ERR! missing script: install\n",
          },
        },
      }),
    );
    expect(html).toContain("Failed");
    expect(html).toContain("exit code 1");
    expect(html).toContain("npm ERR! missing script");
  });

  it("no setup script configured — Re-run setup is disabled with the terminal-command hint", () => {
    const html = renderBody(
      baseProps({ config: { runScript: "npm run dev", setupScript: undefined } }),
    );
    expect(html).toContain("No setup script configured");
    expect(html).toContain("kvy workspace config --setup-script");
  });
});

describe("RunPanel (integration via a mock actions source)", () => {
  it("renders a configured, idle panel end to end through useRunPanel", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["run-config", "/repo"], {
      runScript: "npm run dev",
      setupScript: "npm install",
    });
    queryClient.setQueryData(["run-status", "/repo"], {
      run: { state: "none" },
      setup: { state: "not-run" },
    });

    const useActions: UseRunPanelActions = () => ({
      getConfig: () => new Promise(() => {}), // never resolves — cached data already satisfies the render
      start: () => new Promise(() => {}),
      stop: () => new Promise(() => {}),
      status: () => new Promise(() => {}),
      setup: () => new Promise(() => {}),
    });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RunPanel, { machineId: "mach-1", worktree: "/repo", useActions }),
      ),
    );

    expect(html).toContain("Play");
    expect(html).toContain("Not started");
  });
});
