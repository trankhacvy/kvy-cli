import { describe, expect, it } from "vitest";
import { manualCompareUrl } from "./manual-pr-url";

describe("manualCompareUrl", () => {
  it("is null while checks hasn't loaded", () => {
    expect(manualCompareUrl(undefined)).toBe(null);
  });

  it("is null for no-token/not-pushed/unsupported-remote — nothing to compare yet", () => {
    expect(manualCompareUrl({ state: "no-token" })).toBe(null);
    expect(manualCompareUrl({ state: "not-pushed" })).toBe(null);
    expect(manualCompareUrl({ state: "unsupported-remote" })).toBe(null);
  });

  it("builds a compare URL for no-pr when repo and branch are both present", () => {
    const url = manualCompareUrl({
      state: "no-pr",
      repo: { owner: "acme", name: "widgets" },
      branch: "wf/my-feature",
    });
    expect(url).toBe("https://github.com/acme/widgets/compare/wf/my-feature?expand=1");
  });

  it("is null for no-pr when repo or branch is missing", () => {
    expect(manualCompareUrl({ state: "no-pr", branch: "wf/x" })).toBe(null);
    expect(manualCompareUrl({ state: "no-pr", repo: { owner: "acme", name: "widgets" } })).toBe(
      null,
    );
  });

  it("returns the PR's own url for state=ok with a pr", () => {
    const url = manualCompareUrl({
      state: "ok",
      pr: {
        number: 5,
        title: "x",
        url: "https://github.com/acme/widgets/pull/5",
        state: "open",
        headSha: "abc",
      },
    });
    expect(url).toBe("https://github.com/acme/widgets/pull/5");
  });

  it("is null for state=ok with no pr", () => {
    expect(manualCompareUrl({ state: "ok" })).toBe(null);
  });
});
