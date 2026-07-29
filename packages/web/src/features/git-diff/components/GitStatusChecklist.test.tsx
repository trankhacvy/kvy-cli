import type { GithubChecksResult } from "@falcon/wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GitStatusChecklist, PrChecklistRow } from "./GitStatusChecklist";

/** Same markup-smoke-test precedent as `GitToolbar.test.tsx`/`GitStatusError.test.tsx`. */
function render(checks: GithubChecksResult | undefined) {
  return renderToStaticMarkup(createElement(PrChecklistRow, { checks, onCreatePr: vi.fn() }));
}

describe("PrChecklistRow", () => {
  it("shows a loading row when checks is undefined (still fetching)", () => {
    expect(render(undefined)).toContain("Checking PR status");
  });

  it('state "no-token": GitHub not connected', () => {
    expect(render({ state: "no-token" })).toContain("GitHub not connected on this machine");
  });

  it('state "unsupported-remote": uses the result\'s own message', () => {
    expect(render({ state: "unsupported-remote", message: "detached HEAD" })).toContain(
      "detached HEAD",
    );
  });

  it('state "unsupported-remote": falls back to a generic message when none is given', () => {
    expect(render({ state: "unsupported-remote" })).toContain("Remote not supported");
  });

  it('state "not-pushed": not pushed yet', () => {
    expect(render({ state: "not-pushed" })).toContain("Not pushed yet");
  });

  it('state "no-pr": offers a Create PR action', () => {
    const html = render({ state: "no-pr", branch: "wf/x" });
    expect(html).toContain("No PR open");
    expect(html).toContain("Create PR");
  });

  it('state "ok" with no pr: same as "no-pr" — offers Create PR', () => {
    const html = render({ state: "ok" });
    expect(html).toContain("No PR open");
    expect(html).toContain("Create PR");
  });

  it('state "ok" with an open pr: shows the PR number/state, marked done, no action button', () => {
    const html = render({
      state: "ok",
      pr: {
        number: 42,
        title: "Add feature",
        url: "https://github.com/o/r/pull/42",
        state: "open",
        headSha: "abc",
      },
    });
    expect(html).toContain("PR #42 open");
    expect(html).not.toContain("Create PR");
  });

  it('state "ok" with a merged pr: shows the PR state but NOT marked done (only "open" counts as done)', () => {
    const html = render({
      state: "ok",
      pr: {
        number: 7,
        title: "Old change",
        url: "https://github.com/o/r/pull/7",
        state: "merged",
        headSha: "abc",
      },
    });
    expect(html).toContain("PR #7 merged");
  });
});

describe("GitStatusChecklist", () => {
  it("shows the uncommitted-change count singular/plural correctly", () => {
    const one = renderToStaticMarkup(
      createElement(GitStatusChecklist, {
        uncommittedCount: 1,
        checks: { state: "ok" },
        onCommitAndPush: vi.fn(),
        onCreatePr: vi.fn(),
      }),
    );
    expect(one).toContain("1 uncommitted change");
    expect(one).not.toContain("1 uncommitted changes");

    const many = renderToStaticMarkup(
      createElement(GitStatusChecklist, {
        uncommittedCount: 3,
        checks: { state: "ok" },
        onCommitAndPush: vi.fn(),
        onCreatePr: vi.fn(),
      }),
    );
    expect(many).toContain("3 uncommitted changes");
  });

  it("marks the uncommitted row done when the count is zero, with no action button", () => {
    const html = renderToStaticMarkup(
      createElement(GitStatusChecklist, {
        uncommittedCount: 0,
        checks: { state: "ok" },
        onCommitAndPush: vi.fn(),
        onCreatePr: vi.fn(),
      }),
    );
    expect(html).toContain("0 uncommitted changes");
    expect(html).not.toContain("Commit and push");
  });

  it("never calls onCommitAndPush/onCreatePr merely by rendering", () => {
    const onCommitAndPush = vi.fn();
    const onCreatePr = vi.fn();
    renderToStaticMarkup(
      createElement(GitStatusChecklist, {
        uncommittedCount: 2,
        checks: { state: "no-pr" },
        onCommitAndPush,
        onCreatePr,
      }),
    );
    expect(onCommitAndPush).not.toHaveBeenCalled();
    expect(onCreatePr).not.toHaveBeenCalled();
  });
});
