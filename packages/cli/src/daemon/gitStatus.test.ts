import { describe, expect, it } from "vitest";
import { getGitStatus } from "./gitStatus.js";
import { WorkspaceValidationError } from "./workspacePath.js";

/** Every test here exercises the porcelain-parsing logic against a fake `worktree` path that doesn't exist on disk — bypasses the real filesystem check so those tests don't depend on it. */
const skipWorkspaceValidation = async () => {};

/**
 * Builds an args-aware fake `git`: `status` returns `statusOutput` verbatim;
 * `diff --name-status <ref>`/`diff --numstat <ref>` return whatever
 * `nameStatusOutput`/`numstatOutput` say for that `ref` (defaults to empty —
 * "nothing differs from the base ref"); `rev-parse --verify` (used by
 * `gitBaseRef.ts` to probe for a local `main`/`master` and for `HEAD`
 * itself) fails unless `existingRefs` says otherwise, matching the "nothing
 * configured, no main/master, has commits" default most tests want.
 */
/** Builds a fake `noIndexDiff` (`git diff --no-index --numstat -- /dev/null <path>`) keyed by the requested path — an untracked file's own stat call. Defaults to a plain text file's numstat when a path has no entry, matching `parseSingleFileNumstat`'s expected shape. */
function fakeNoIndexDiff(numstatByPath: Record<string, string> = {}) {
  return async (args: string[], _cwd: string): Promise<string> => {
    const path = args[args.length - 1] as string;
    return numstatByPath[path] ?? "";
  };
}

function fakeGit(options: {
  statusOutput: string;
  nameStatusOutput?: string;
  numstatOutput?: string;
  existingRefs?: string[];
}) {
  const existingRefs = new Set(options.existingRefs ?? ["HEAD"]);
  return async (args: string[], _cwd: string): Promise<string> => {
    if (args[0] === "status") return options.statusOutput;
    if (args[0] === "rev-parse") {
      const ref = args[args.length - 1] as string;
      if (existingRefs.has(ref) || existingRefs.has(ref.replace(/^refs\/heads\//, ""))) return "";
      throw new Error(`fatal: ambiguous argument '${ref}'`);
    }
    if (args[0] === "diff" && args.includes("--name-status")) {
      return options.nameStatusOutput ?? "";
    }
    if (args[0] === "diff" && args.includes("--numstat")) {
      return options.numstatOutput ?? "";
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

describe("getGitStatus", () => {
  it("parses branch and ahead/behind from porcelain v2, and builds the file list from the base-ref diff", async () => {
    const statusOutput = [
      "# branch.oid abc123",
      "# branch.head feature",
      "# branch.upstream origin/feature",
      "# branch.ab +2 -1",
      "? src/untracked.ts",
      "",
    ].join("\n");
    const nameStatusOutput = ["M\tsrc/a.ts", "A\tsrc/new.ts", "D\tsrc/old.ts", ""].join("\n");
    const numstatOutput = ["4\t1\tsrc/a.ts", "10\t0\tsrc/new.ts", "0\t7\tsrc/old.ts", ""].join(
      "\n",
    );

    const result = await getGitStatus(
      { idempotencyKey: "idem-1", worktree: "/repo" },
      {
        git: fakeGit({
          statusOutput,
          nameStatusOutput,
          numstatOutput,
          existingRefs: ["HEAD", "main"],
        }),
        noIndexDiff: fakeNoIndexDiff({
          "src/untracked.ts": "5\t0\t/dev/null => src/untracked.ts\n",
        }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.branch).toBe("feature");
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(1);
    expect(result.files).toEqual([
      { path: "src/a.ts", status: "modified", insertions: 4, deletions: 1 },
      { path: "src/new.ts", status: "added", insertions: 10, deletions: 0 },
      { path: "src/old.ts", status: "deleted", insertions: 0, deletions: 7 },
      { path: "src/untracked.ts", status: "untracked", insertions: 5, deletions: 0 },
    ]);
  });

  it("requests --untracked-files=all, so an untracked directory is never collapsed into one entry", async () => {
    let statusArgsUsed: string[] | undefined;
    const git = async (args: string[], _cwd: string): Promise<string> => {
      if (args[0] === "status") {
        statusArgsUsed = args;
        return ["# branch.head main", "? src/new/a.txt", "? src/new/b.txt", ""].join("\n");
      }
      return "";
    };

    const result = await getGitStatus(
      { idempotencyKey: "idem-untracked-dir-1", worktree: "/repo" },
      {
        git,
        noIndexDiff: fakeNoIndexDiff({
          "src/new/a.txt": "1\t0\t/dev/null => src/new/a.txt\n",
          "src/new/b.txt": "2\t0\t/dev/null => src/new/b.txt\n",
        }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(statusArgsUsed).toContain("--untracked-files=all");
    expect(result.files).toEqual([
      { path: "src/new/a.txt", status: "untracked", insertions: 1, deletions: 0 },
      { path: "src/new/b.txt", status: "untracked", insertions: 2, deletions: 0 },
    ]);
  });

  it("sums every numstat line for an untracked path rather than only reading the first (defense in depth: git diff --no-index can't actually diff a file against a directory, but this guards against ever silently under-counting again if that changes)", async () => {
    const statusOutput = ["# branch.oid abc123", "# branch.head main", "? src/new/", ""].join("\n");
    // Simulates what a multi-file directory's numstat would look like, were
    // it ever handed straight to noIndexDiff instead of individual files.
    const multiLineNumstat = [
      "1\t0\t/dev/null => src/new/a.txt",
      "2\t3\t/dev/null => src/new/b.txt",
      "",
    ].join("\n");

    const result = await getGitStatus(
      { idempotencyKey: "idem-untracked-dir-2", worktree: "/repo" },
      {
        git: fakeGit({ statusOutput, existingRefs: ["HEAD", "main"] }),
        noIndexDiff: fakeNoIndexDiff({ "src/new/": multiLineNumstat }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.files).toEqual([
      { path: "src/new/", status: "untracked", insertions: 3, deletions: 3 },
    ]);
  });

  it("omits insertions/deletions for a binary untracked file (its own numstat reports '-')", async () => {
    const statusOutput = [
      "# branch.oid abc123",
      "# branch.head main",
      "? assets/new-logo.png",
      "",
    ].join("\n");

    const result = await getGitStatus(
      { idempotencyKey: "idem-1b", worktree: "/repo" },
      {
        git: fakeGit({ statusOutput, existingRefs: ["HEAD", "main"] }),
        noIndexDiff: fakeNoIndexDiff({
          "assets/new-logo.png": "-\t-\t/dev/null => assets/new-logo.png\n",
        }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.files).toEqual([{ path: "assets/new-logo.png", status: "untracked" }]);
  });

  it("diffs against the resolved base ref (main), not the literal string 'HEAD'", async () => {
    const statusOutput = ["# branch.oid abc123", "# branch.head feature", ""].join("\n");
    let diffRefUsed: string | undefined;

    const git = async (args: string[], _cwd: string): Promise<string> => {
      if (args[0] === "status") return statusOutput;
      if (args[0] === "rev-parse") {
        const ref = args[args.length - 1] as string;
        if (ref === "refs/heads/main") return "";
        throw new Error("fatal: ambiguous argument");
      }
      if (args[0] === "diff") {
        diffRefUsed = args[args.length - 1];
        return "";
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };

    await getGitStatus(
      { idempotencyKey: "idem-2", worktree: "/repo" },
      { git, assertWorkspaceValid: skipWorkspaceValidation },
    );

    expect(diffRefUsed).toBe("main");
  });

  it("omits insertions/deletions for a binary file (numstat reports '-')", async () => {
    const statusOutput = ["# branch.oid abc123", "# branch.head main", ""].join("\n");
    const nameStatusOutput = "M\tassets/logo.png\n";
    const numstatOutput = "-\t-\tassets/logo.png\n";

    const result = await getGitStatus(
      { idempotencyKey: "idem-3", worktree: "/repo" },
      {
        git: fakeGit({
          statusOutput,
          nameStatusOutput,
          numstatOutput,
          existingRefs: ["HEAD", "main"],
        }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.files).toEqual([{ path: "assets/logo.png", status: "modified" }]);
  });

  it("defaults ahead/behind to 0 when there's no upstream (no branch.ab line)", async () => {
    const statusOutput = ["# branch.oid abc123", "# branch.head feature", ""].join("\n");

    const result = await getGitStatus(
      { idempotencyKey: "idem-4", worktree: "/repo" },
      {
        git: fakeGit({ statusOutput }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.branch).toBe("feature");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.files).toEqual([]);
  });

  it("handles a detached HEAD and unmerged (conflict) entries, which win over the ref-diff's own classification", async () => {
    const statusOutput = [
      "# branch.oid abc123",
      "# branch.head (detached)",
      "u AA N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts",
      "",
    ].join("\n");
    // The base-ref diff also sees `src/conflict.ts` as merely "modified" —
    // the unmerged (conflict) classification from `git status` must win.
    const nameStatusOutput = "M\tsrc/conflict.ts\n";
    const numstatOutput = "3\t1\tsrc/conflict.ts\n";

    const result = await getGitStatus(
      { idempotencyKey: "idem-5", worktree: "/repo" },
      {
        git: fakeGit({ statusOutput, nameStatusOutput, numstatOutput }),
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.branch).toBe("(detached)");
    expect(result.files).toEqual([{ path: "src/conflict.ts", status: "modified" }]);
  });

  it("propagates a git failure (e.g. not a repository) rather than returning empty status", async () => {
    const git = async () => {
      throw new Error("fatal: not a git repository");
    };

    await expect(
      getGitStatus(
        { idempotencyKey: "idem-6", worktree: "/not-a-repo" },
        { git, assertWorkspaceValid: skipWorkspaceValidation },
      ),
    ).rejects.toThrow("not a git repository");
  });

  it("propagates a WorkspaceValidationError from assertWorkspaceValid without ever calling git", async () => {
    let gitCalled = false;
    const git = async () => {
      gitCalled = true;
      return "";
    };

    await expect(
      getGitStatus(
        { idempotencyKey: "idem-7", worktree: "/gone" },
        {
          git,
          assertWorkspaceValid: async () => {
            throw new WorkspaceValidationError(
              "workspace directory not found: /gone",
              "workspace-missing",
            );
          },
        },
      ),
    ).rejects.toMatchObject({ name: "WorkspaceValidationError", code: "workspace-missing" });
    expect(gitCalled).toBe(false);
  });

  it("checks the workspace's real filesystem state by default when no override is given", async () => {
    await expect(
      getGitStatus(
        { idempotencyKey: "idem-8", worktree: "/definitely/does/not/exist/anywhere" },
        { git: fakeGit({ statusOutput: "" }) },
      ),
    ).rejects.toMatchObject({ name: "WorkspaceValidationError", code: "workspace-missing" });
  });
});
