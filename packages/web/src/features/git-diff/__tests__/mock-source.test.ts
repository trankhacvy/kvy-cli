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

  it("initRepo resolves already-repo (Feature 1) — this mock's fetchStatus always already succeeds", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const result = await actions.initRepo("/repo");
    expect(result.state).toBe("already-repo");
  });

  it("listRemotes returns a non-empty seed list", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const remotes = await actions.listRemotes("/repo");
    expect(remotes.length).toBeGreaterThan(0);
    expect(remotes[0]).toMatchObject({ name: "origin" });
  });

  it("setRemote adds a brand-new remote name (created:true) without disturbing the existing one", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const before = await actions.listRemotes("/repo");

    const result = await actions.setRemote("/repo", "git@github.com:x/y.git", "upstream");
    expect(result).toEqual({
      ok: true,
      name: "upstream",
      url: "git@github.com:x/y.git",
      created: true,
    });

    const after = await actions.listRemotes("/repo");
    expect(after.length).toBe(before.length + 1);
    expect(after.find((r) => r.name === "origin")).toEqual(before.find((r) => r.name === "origin"));
  });

  it("setRemote updates an existing remote's URL in place (created:false)", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const before = await actions.listRemotes("/repo");

    const result = await actions.setRemote("/repo", "https://example.com/new.git", "origin");
    expect(result).toEqual({
      ok: true,
      name: "origin",
      url: "https://example.com/new.git",
      created: false,
    });

    const after = await actions.listRemotes("/repo");
    expect(after.length).toBe(before.length);
    expect(after.find((r) => r.name === "origin")?.url).toBe("https://example.com/new.git");
  });

  it("setRemote with no explicit name defaults to origin", async () => {
    const actions = createMockGitDiffActions("mach-1");
    const result = await actions.setRemote("/repo", "https://example.com/new.git");
    expect(result.name).toBe("origin");
  });
});
