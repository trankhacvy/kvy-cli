import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOCK_GITHUB_CHECKS_FIXTURES } from "../mock-source";
import type { UseGithubChecksActions } from "../types";
import { DaemonUnsupportedError } from "../types";
import { ChecksBody } from "./ChecksPanel";

function renderBody(props: Parameters<typeof ChecksBody>[0]): string {
  return renderToStaticMarkup(createElement(ChecksBody, props));
}

describe("ChecksBody", () => {
  it("shows a loading message while isLoading is true", () => {
    expect(renderBody({ isLoading: true, error: null, checks: undefined })).toContain(
      "Loading checks",
    );
  });

  it("shows the daemon-unsupported message for a DaemonUnsupportedError", () => {
    const html = renderBody({
      isLoading: false,
      error: new DaemonUnsupportedError(),
      checks: undefined,
    });
    expect(html).toContain("doesn&#x27;t support CI checks yet");
    expect(html).toContain("update falcon and restart");
  });

  it("shows a generic error message for any other error", () => {
    const html = renderBody({
      isLoading: false,
      error: new Error("network unreachable"),
      checks: undefined,
    });
    expect(html).toContain("Could not load checks");
    expect(html).toContain("network unreachable");
  });

  it("state: no-token — shows the 'GitHub is not connected' CTA", () => {
    const html = renderBody({
      isLoading: false,
      error: null,
      checks: MOCK_GITHUB_CHECKS_FIXTURES["no-token"],
    });
    expect(html).toContain("GitHub is not connected on this machine");
    expect(html).toContain("falcon github login");
  });

  it("state: unsupported-remote — shows the result's own message", () => {
    const html = renderBody({
      isLoading: false,
      error: null,
      checks: MOCK_GITHUB_CHECKS_FIXTURES["unsupported-remote"],
    });
    expect(html).toContain("isn&#x27;t a github.com repository");
  });

  it("state: not-pushed — shows the 'commit and push' copy", () => {
    const html = renderBody({
      isLoading: false,
      error: null,
      checks: MOCK_GITHUB_CHECKS_FIXTURES["not-pushed"],
    });
    expect(html).toContain("Commit and push your changes, then create a PR");
  });

  it("state: no-pr — shows the branch-specific 'no open pull request' copy", () => {
    const html = renderBody({
      isLoading: false,
      error: null,
      checks: MOCK_GITHUB_CHECKS_FIXTURES["no-pr"],
    });
    expect(html).toContain("No open pull request for feature/checks-tab");
  });

  it("state: ok — shows the PR header and every check run", () => {
    const html = renderBody({
      isLoading: false,
      error: null,
      checks: MOCK_GITHUB_CHECKS_FIXTURES.ok,
    });
    expect(html).toContain("Add the Checks tab");
    expect(html).toContain("build");
    expect(html).toContain("typecheck");
    expect(html).toContain("test");
    expect(html).toContain("lint");
  });
});

describe("ChecksPanel (integration via a mock actions source)", () => {
  it("renders the ok fixture end to end through useChecksPanel", async () => {
    const { ChecksPanel } = await import("./ChecksPanel");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["github-checks", "/repo"], MOCK_GITHUB_CHECKS_FIXTURES.ok);

    const useActions: UseGithubChecksActions = () => ({
      fetchChecks: () => new Promise(() => {}), // never resolves — cached data already satisfies the render
    });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ChecksPanel, { machineId: "mach-1", worktree: "/repo", useActions }),
      ),
    );

    expect(html).toContain("Add the Checks tab");
  });
});
