import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GitPanelState } from "../use-git-panel";
import { GitStatusError } from "./GitStatusError";

/** Same fakePanel/markup-smoke-test precedent as `GitToolbar.test.tsx` (this
 * package has no jsdom/`@testing-library/react` click simulation). */
function fakePanel(overrides: Partial<GitPanelState> = {}): GitPanelState {
  const base = {
    status: undefined,
    statusError: "workspace is no longer a git repository: /some/path",
    statusErrorCode: undefined,
    isStatusLoading: false,
    selectedPath: null,
    selectFile: vi.fn(),
    diff: undefined,
    diffError: null,
    isDiffLoading: false,

    removeWorkspace: vi.fn(),
    isRemoveWorkspacePending: false,
    removeWorkspaceDone: false,

    initRepo: vi.fn(),
    isInitRepoPending: false,
    initRepoError: null,
    initRepoResult: undefined,

    compareRef: null,
    setCompareRef: vi.fn(),
    branches: [],
    isBranchesLoading: false,

    commit: vi.fn(),
    isCommitPending: false,
    commitError: null,
    commitResult: undefined,

    push: vi.fn(),
    isPushPending: false,
    pushError: null,

    renameBranch: vi.fn(),
    isRenameBranchPending: false,
    renameBranchError: null,
    renameBranchResult: undefined,
  };
  return { ...base, ...overrides } as unknown as GitPanelState;
}

describe("GitStatusError", () => {
  it("shows the raw error as a destructive (red) notice when the code isn't a recognized workspace problem", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("workspace is no longer a git repository");
    expect(html).toContain("text-destructive");
  });

  it("shows plain-language copy, muted (not red), for 'workspace-not-a-repo' — this folder simply isn't a git project, not a broken state", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("set up as a git project");
    expect(html).not.toContain("workspace is no longer a git repository");
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("text-muted-foreground");
  });

  it("shows plain-language copy, muted, for 'workspace-missing'", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-missing" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("moved, renamed, or deleted");
    expect(html).not.toContain("text-destructive");
  });

  it("offers 'Set up git here' when statusErrorCode is workspace-not-a-repo (Feature 1)", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("Set up git here");
  });

  it("does NOT offer 'Set up git here' for workspace-missing — there is nothing safe to init on a gone folder", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-missing" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).not.toContain("Set up git here");
  });

  it("shows the existingRoot note and hides the init button when initRepo resolved inside-existing-repo", () => {
    const panel = fakePanel({
      statusErrorCode: "workspace-not-a-repo",
      initRepoResult: { state: "inside-existing-repo", existingRoot: "/repo" },
    });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("/repo");
    expect(html).not.toContain("Set up git here");
  });

  it("shows initRepoError in destructive text when set", () => {
    const panel = fakePanel({
      statusErrorCode: "workspace-not-a-repo",
      initRepoError: "unknown-method",
    });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("unknown-method");
  });

  it("offers the forget-this-project affordance as an unstyled <button>, not a primary Button — the destructive action stays a link (CLAUDE.md auth/UX rule #5)", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("Forget this project");
    expect(html).toContain("nothing on disk changes");
    const suffix =
      ">Forget this project: Falcon stops tracking the folder, nothing on disk changes</button>";
    const end = html.indexOf(suffix);
    const start = html.lastIndexOf("<button", end);
    const forgetTag = html.slice(start, end + suffix.length);
    expect(forgetTag).not.toContain('data-slot="button"');
    expect(forgetTag).toContain("underline");
  });

  it("swaps the forget-this-project affordance for a confirmation once the workspace has been removed", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo", removeWorkspaceDone: true });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).not.toContain("Forget this project");
    expect(html).toContain("Removed.");
  });

  it("never calls removeWorkspace or initRepo merely by rendering", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(panel.removeWorkspace).not.toHaveBeenCalled();
    expect(panel.initRepo).not.toHaveBeenCalled();
  });
});
