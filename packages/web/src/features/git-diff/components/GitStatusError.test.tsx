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

  it("offers a 'Remove this workspace' button for a recognized workspace problem", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).toContain("Remove this workspace");
  });

  it("swaps the button for a confirmation once the workspace has been removed", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo", removeWorkspaceDone: true });
    const html = renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(html).not.toContain("Remove this workspace");
    expect(html).toContain("Removed.");
  });

  it("never calls removeWorkspace merely by rendering", () => {
    const panel = fakePanel({ statusErrorCode: "workspace-not-a-repo" });
    renderToStaticMarkup(createElement(GitStatusError, { panel }));
    expect(panel.removeWorkspace).not.toHaveBeenCalled();
  });
});
