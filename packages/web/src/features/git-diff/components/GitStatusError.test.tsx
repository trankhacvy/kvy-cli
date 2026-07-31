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
    // The message itself stays muted — the Remove-workspace button below it
    // is a separate, deliberately destructive-styled action, not a signal
    // that this whole state is alarming.
    expect(html).toContain(
      'class="text-muted-foreground">This folder isn&#x27;t set up as a git project.</p>',
    );
  });

  it("shows plain-language copy, muted, for 'workspace-missing'", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-missing" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("moved, renamed, or deleted");
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

  it("offers the remove-workspace control for workspace-missing — nothing else can fix a gone folder", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-missing" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("Remove workspace");
  });

  it("does NOT offer the remove-workspace control for workspace-not-a-repo — 'Set up git here' is the real fix, not deleting the workspace", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).not.toContain("Remove workspace");
  });

  it("swaps the remove-workspace control for a confirmation once the workspace has been removed", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-missing", removeWorkspaceDone: true });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).not.toContain("Remove workspace");
    expect(html).toContain("Removed.");
  });

  it("never calls removeWorkspace or initRepo merely by rendering", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(panel.removeWorkspace).not.toHaveBeenCalled();
    expect(panel.initRepo).not.toHaveBeenCalled();
  });
});
