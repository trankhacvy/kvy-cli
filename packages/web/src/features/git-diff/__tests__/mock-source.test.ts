import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/unifiedDiff";
import { createMockGitDiffActions } from "../mock-source";

describe("createMockGitDiffActions", () => {
  it("fetchStatus returns a non-empty file list with a branch and ahead/behind counts", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const status = await actions.fetchStatus("/repo");

    expect(status.branch).toBeTruthy();
    expect(status.files.length).toBeGreaterThan(0);
    expect(typeof status.ahead).toBe("number");
    expect(typeof status.behind).toBe("number");
  });

  it("fetchDiff for a specific known path returns a parseable, non-truncated unified diff", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const status = await actions.fetchStatus("/repo");
    const target = status.files[0]?.path as string;

    const diff = await actions.fetchDiff("/repo", { path: target });

    expect(diff.truncated).toBe(false);
    expect(diff.inline).toBeDefined();
    const parsed = parseUnifiedDiff(diff.inline as string);
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it("fetchDiff for every file in the mock status returns a diff mentioning that path", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const status = await actions.fetchStatus("/repo");

    for (const file of status.files) {
      const diff = await actions.fetchDiff("/repo", { path: file.path });
      expect(diff.inline).toContain(file.path);
    }
  });

  it("fetchDiff with no path returns the full multi-file diff", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const diff = await actions.fetchDiff("/repo");
    const parsed = parseUnifiedDiff(diff.inline as string);
    expect(parsed.files.length).toBeGreaterThan(1);
  });

  it("commit resolves a committed result with a commitSha", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const result = await actions.commit("/repo", "fix bug");
    expect(result.committed).toBe(true);
    expect(result.commitSha).toBeTruthy();
  });

  it("push resolves ok with the current branch, echoing the force flag", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const status = await actions.fetchStatus("/repo");

    const plain = await actions.push("/repo");
    expect(plain).toEqual({ remote: "origin", branch: status.branch, forced: false });

    const forced = await actions.push("/repo", { force: true });
    expect(forced.forced).toBe(true);
  });

  it("renameBranch echoes the new name with hadUpstream:true", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const result = await actions.renameBranch("/repo", "renamed");
    expect(result).toEqual({ branch: "renamed", hadUpstream: true });
  });

  it("listBranches returns multiple branches including the current one", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const status = await actions.fetchStatus("/repo");
    const branches = await actions.listBranches("/repo");

    expect(branches.length).toBeGreaterThanOrEqual(2);
    expect(branches.some((b) => b.name === status.branch && b.isCurrent)).toBe(true);
  });
});
