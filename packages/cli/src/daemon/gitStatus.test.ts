import { describe, expect, it } from "vitest";
import { getGitStatus } from "./gitStatus.js";

function fakeGit(output: string) {
  return async (_args: string[], _cwd: string) => output;
}

describe("getGitStatus", () => {
  it("parses branch, ahead/behind, and file statuses from porcelain v2", async () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 aaaa bbbb src/a.ts",
      "1 A. N... 000000 100644 100644 0000 cccc src/new.ts",
      "1 .D N... 100644 000000 000000 dddd 0000 src/old.ts",
      "2 R. N... 100644 100644 100644 eeee ffff R100 src/renamed.ts\tsrc/original.ts",
      "? src/untracked.ts",
      "",
    ].join("\n");

    const result = await getGitStatus(
      { idempotencyKey: "idem-1", worktree: "/repo" },
      { git: fakeGit(output) },
    );

    expect(result.branch).toBe("main");
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(1);
    expect(result.files).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", status: "added" },
      { path: "src/old.ts", status: "deleted" },
      { path: "src/renamed.ts", status: "renamed" },
      { path: "src/untracked.ts", status: "untracked" },
    ]);
  });

  it("defaults ahead/behind to 0 when there's no upstream (no branch.ab line)", async () => {
    const output = ["# branch.oid abc123", "# branch.head feature", ""].join("\n");

    const result = await getGitStatus(
      { idempotencyKey: "idem-2", worktree: "/repo" },
      { git: fakeGit(output) },
    );

    expect(result.branch).toBe("feature");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("handles a detached HEAD and unmerged (conflict) entries", async () => {
    const output = [
      "# branch.oid abc123",
      "# branch.head (detached)",
      "u AA N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts",
      "",
    ].join("\n");

    const result = await getGitStatus(
      { idempotencyKey: "idem-3", worktree: "/repo" },
      { git: fakeGit(output) },
    );

    expect(result.branch).toBe("(detached)");
    expect(result.files).toEqual([{ path: "src/conflict.ts", status: "added" }]);
  });

  it("propagates a git failure (e.g. not a repository) rather than returning empty status", async () => {
    const git = async () => {
      throw new Error("fatal: not a git repository");
    };

    await expect(
      getGitStatus({ idempotencyKey: "idem-4", worktree: "/not-a-repo" }, { git }),
    ).rejects.toThrow("not a git repository");
  });
});
