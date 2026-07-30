import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GitPanelState } from "../use-git-panel";
import { GitToolbar } from "./GitToolbar";

/**
 * `GitToolbar`'s interactive behavior (inline rename on Enter, the Force
 * Push confirm gate, Commit's stageAll wiring) is proven at the pure-logic
 * level by `git-toolbar-state.test.ts` — this package has no jsdom/
 * `@testing-library/react` wired up, so a real click/keystroke can't be
 * simulated here (same constraint `use-git-panel.test.ts` and
 * `features/unmanaged-sessions/take-over-dialog-state.ts`'s own precedent
 * both note: state-machine logic lives in a plain, directly-tested module;
 * the component itself gets only a markup smoke-test). These tests assert
 * the rendered structure — the branch name, the commit box, the Force Push
 * confirm dialog's exact copy — and that mounting alone never fires a
 * mutation.
 */
function fakePanel(overrides: Partial<GitPanelState> = {}): GitPanelState {
  const base = {
    status: { branch: "main", ahead: 1, behind: 0, files: [] },
    statusError: null,
    isStatusLoading: false,
    selectedPath: null,
    selectFile: vi.fn(),
    diff: undefined,
    diffError: null,
    isDiffLoading: false,

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

    commitAndPush: vi.fn(),
    isCommitAndPushPending: false,

    renameBranch: vi.fn(),
    isRenameBranchPending: false,
    renameBranchError: null,
    renameBranchResult: undefined,

    remotes: undefined,
    pushReadiness: "ready" as const,

    setRemote: vi.fn(),
    isSetRemotePending: false,
    setRemoteError: null,
  };
  return { ...base, ...overrides } as unknown as GitPanelState;
}

describe("GitToolbar", () => {
  it("renders the current branch name as a clickable (rename) button", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain("main");
    expect(html).toContain("<button");
  });

  it("renders a commit message box, a Commit button, and the include-untracked checkbox checked by default", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain("Commit message");
    expect(html).toContain("Commit");
    expect(html).toContain("Include untracked");
    expect(html).toContain('checked=""');
  });

  it("gives the commit textarea a stable id so the Changes-tab checklist can focus it (session-panel-workflow-plan.md Phase 1.2)", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain('id="git-toolbar-commit-message"');
  });

  it("renders a Commit & Push button", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain("Commit &amp; Push");
  });

  it("shows 'Committed, but push failed' when a commit succeeded and pushError is set", () => {
    const panel = fakePanel({
      commitResult: { committed: true, commitSha: "abc1234" },
      pushError: "fatal: could not read Username",
    });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain("Committed, but push failed");
    expect(html).toContain("fatal: could not read Username");
  });

  it("renders Push and Force Push trigger buttons", () => {
    // The confirm dialog's own safety copy ("Force push uses
    // --force-with-lease...") is NOT asserted here: Radix's
    // `DialogPrimitive.Content` only renders while `open` — the dialog
    // starts closed (`forcePushOpen` internal state), and opening it needs
    // a real click this package's jsdom-less vitest config can't simulate.
    // The copy is a plain literal in `GitToolbar.tsx` (grepped, not
    // rendered, in the check below) — an actual "does the dialog show the
    // right words when opened" pass needs a live/browser test.
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain("Push");
    expect(html).toContain("Force Push");
  });

  it("shows the nothingToCommit outcome and error slots when the panel reports them", () => {
    const panel = fakePanel({
      commitResult: { committed: false, nothingToCommit: true },
      pushError: "fatal: could not read Username",
    });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toContain("Nothing to commit.");
    expect(html).toContain("fatal: could not read Username");
  });

  it("never calls commit/push/commitAndPush/renameBranch merely by rendering", () => {
    const panel = fakePanel();
    renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(panel.commit).not.toHaveBeenCalled();
    expect(panel.push).not.toHaveBeenCalled();
    expect(panel.commitAndPush).not.toHaveBeenCalled();
    expect(panel.renameBranch).not.toHaveBeenCalled();
  });

  it("renders nothing when status hasn't loaded yet", () => {
    const panel = fakePanel({ status: undefined });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(html).toBe("");
  });

  // Push/Force Push are the only buttons whose `disabled` isn't already
  // masked by the (untestable without jsdom) empty-commit-message gate, so
  // they're what these regression cases assert on: each of the three git
  // mutations must block the other two, not just its own button.
  function buttonTag(html: string, text: string): string | undefined {
    const suffix = `>${text}</button>`;
    const end = html.indexOf(suffix);
    if (end === -1) return undefined;
    const start = html.lastIndexOf("<button", end);
    return html.slice(start, end + suffix.length);
  }

  it("disables Push and Force Push while commitAndPush is in flight", () => {
    const panel = fakePanel({ isCommitAndPushPending: true });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(buttonTag(html, "Push")).toContain("disabled=");
    expect(buttonTag(html, "Force Push")).toContain("disabled=");
  });

  it("disables Push and Force Push while a standalone commit is pending", () => {
    const panel = fakePanel({ isCommitPending: true });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(buttonTag(html, "Push")).toContain("disabled=");
    expect(buttonTag(html, "Force Push")).toContain("disabled=");
  });

  it("disables Commit and Commit & Push while a standalone push is pending", () => {
    const panel = fakePanel({ isPushPending: true });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(buttonTag(html, "Commit")).toContain("disabled=");
    expect(buttonTag(html, "Commit &amp; Push")).toContain("disabled=");
  });

  // Feature 2 (docs/web-ux-improvements-plan.md): a confidently-offline
  // machine disables every write action here, not just the ones already
  // gated on their own pending flags.
  it("disables Push and Force Push when machineUnavailable is true, even with nothing else pending", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(
      createElement(GitToolbar, { panel, machineUnavailable: true }),
    );
    expect(buttonTag(html, "Push")).toContain("disabled=");
    expect(buttonTag(html, "Force Push")).toContain("disabled=");
  });

  it("does not disable Push/Force Push when machineUnavailable is omitted (defaults false)", () => {
    const panel = fakePanel();
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(buttonTag(html, "Push")).not.toContain("disabled=");
    expect(buttonTag(html, "Force Push")).not.toContain("disabled=");
  });

  // Feature 1 (docs/web-ux-improvements-plan.md): pushReadiness "no-remote"
  // disables the three push-shaped buttons before the click and offers an
  // inline "Add a remote" affordance instead of letting git's stderr teach
  // the user.
  it("disables Push/Commit & Push/Force Push and shows 'Add a remote' when pushReadiness is no-remote", () => {
    const panel = fakePanel({ pushReadiness: "no-remote" });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(buttonTag(html, "Push")).toContain("disabled=");
    expect(buttonTag(html, "Force Push")).toContain("disabled=");
    expect(html).toContain("nowhere to push");
    expect(html).toContain("Add a remote");
  });

  it("disables the push-shaped buttons for a detached HEAD, with no 'Add a remote' offer", () => {
    const panel = fakePanel({ pushReadiness: "detached" });
    const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(buttonTag(html, "Push")).toContain("disabled=");
    expect(html).toContain("nothing to push");
    expect(html).not.toContain("Add a remote");
  });

  it("does not block Push for pushReadiness 'ready' or 'unknown', and shows no blocked copy", () => {
    for (const readiness of ["ready", "unknown"] as const) {
      const panel = fakePanel({ pushReadiness: readiness });
      const html = renderToStaticMarkup(createElement(GitToolbar, { panel }));
      expect(buttonTag(html, "Push")).not.toContain("disabled=");
      expect(html).not.toContain("Add a remote");
    }
  });

  it("never calls setRemote merely by rendering, even with pushReadiness 'no-remote'", () => {
    const panel = fakePanel({ pushReadiness: "no-remote" });
    renderToStaticMarkup(createElement(GitToolbar, { panel }));
    expect(panel.setRemote).not.toHaveBeenCalled();
  });
});
