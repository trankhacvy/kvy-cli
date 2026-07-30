import { describe, expect, it, vi } from "vitest";
import { getGitDiff } from "./gitDiff.js";
import { WorkspaceValidationError } from "./workspacePath.js";

/** Every test here exercises diff-building logic against a fake `worktree` path that doesn't exist on disk — bypasses the real filesystem check so those tests don't depend on it. */
const skipWorkspaceValidation = async () => {};

describe("getGitDiff", () => {
  it("uses an explicit baseRef when given, without consulting the configured resolver", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);
    const resolveConfiguredBaseRef = vi.fn(async () => "configured-base");

    const result = await getGitDiff(
      { idempotencyKey: "idem-1", worktree: "/repo", baseRef: "explicit-base" },
      { git, resolveConfiguredBaseRef, assertWorkspaceValid: skipWorkspaceValidation },
    );

    expect(git).toHaveBeenCalledWith(["diff", "explicit-base"], "/repo");
    expect(resolveConfiguredBaseRef).not.toHaveBeenCalled();
    expect(result).toEqual({ inline: "diff against diff explicit-base", truncated: false });
  });

  it("falls back to the workspace's configured base ref when params.baseRef is omitted", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);
    const resolveConfiguredBaseRef = vi.fn(async () => "develop");

    await getGitDiff(
      { idempotencyKey: "idem-2", worktree: "/repo" },
      { git, resolveConfiguredBaseRef, assertWorkspaceValid: skipWorkspaceValidation },
    );

    expect(git).toHaveBeenCalledWith(["diff", "develop"], "/repo");
  });

  it("falls back to `git diff HEAD` when nothing is configured and no local main/master branch exists", async () => {
    const git = vi.fn(async (args: string[]) => {
      // `rev-parse --verify` fails for main/master (neither exists) but
      // succeeds for HEAD (the repo has commits) — same "verify, then act"
      // shape `gitBaseRef.test.ts` uses for this module's own unit tests.
      if (args[0] === "rev-parse" && args[args.length - 1] !== "HEAD") {
        throw new Error(`fatal: ambiguous argument '${args[args.length - 1]}'`);
      }
      return `diff against ${args.join(" ")}`;
    });
    const resolveConfiguredBaseRef = vi.fn(async () => undefined);

    await getGitDiff(
      { idempotencyKey: "idem-3", worktree: "/repo" },
      { git, resolveConfiguredBaseRef, assertWorkspaceValid: skipWorkspaceValidation },
    );

    expect(git).toHaveBeenCalledWith(["diff", "HEAD"], "/repo");
  });

  it("falls back to a local main branch when nothing is configured and main exists locally", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[args.length - 1] === "refs/heads/main") return "";
      if (args[0] === "rev-parse") throw new Error("fatal: ambiguous argument");
      return `diff against ${args.join(" ")}`;
    });

    await getGitDiff(
      { idempotencyKey: "idem-3b", worktree: "/repo" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(git).toHaveBeenCalledWith(["diff", "main"], "/repo");
  });

  it("falls back to the git empty-tree hash when the repo has no commits at all", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse") throw new Error("fatal: ambiguous argument");
      return `diff against ${args.join(" ")}`;
    });

    await getGitDiff(
      { idempotencyKey: "idem-3c", worktree: "/repo" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(git).toHaveBeenCalledWith(["diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"], "/repo");
  });

  it("scopes the diff to a single path when params.path is given", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);

    await getGitDiff(
      { idempotencyKey: "idem-4", worktree: "/repo", baseRef: "main", path: "src/a.ts" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(git).toHaveBeenCalledWith(["diff", "main", "--", "src/a.ts"], "/repo");
  });

  it("diffs an untracked path against /dev/null instead of the ref (git diff <ref> can never see it)", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "status") return ["# branch.head main", "? new.txt", ""].join("\n");
      throw new Error("git diff <ref> should never be called for an untracked path");
    });
    const noIndexDiff = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);

    const result = await getGitDiff(
      { idempotencyKey: "idem-untracked-1", worktree: "/repo", baseRef: "main", path: "new.txt" },
      {
        git,
        noIndexDiff,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(noIndexDiff).toHaveBeenCalledWith(
      ["diff", "--no-index", "--", "/dev/null", "new.txt"],
      "/repo",
    );
    expect(result.inline).toBe("diff against diff --no-index -- /dev/null new.txt");
  });

  it("requests --untracked-files=all when listing untracked files, so a directory is never collapsed into one entry noIndexDiff can't actually diff", async () => {
    let statusArgsUsed: string[] | undefined;
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "status") {
        statusArgsUsed = args;
        return ["# branch.head main", "? src/new/a.txt", ""].join("\n");
      }
      return "tracked diff content";
    });
    const noIndexDiff = vi.fn(async () => "untracked diff content");

    await getGitDiff(
      { idempotencyKey: "idem-untracked-flag", worktree: "/repo", baseRef: "main" },
      {
        git,
        noIndexDiff,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(statusArgsUsed).toContain("--untracked-files=all");
    expect(noIndexDiff).toHaveBeenCalledWith(
      ["diff", "--no-index", "--", "/dev/null", "src/new/a.txt"],
      "/repo",
    );
  });

  it("appends each untracked file's own /dev/null diff after the regular ref-diff in the combined (no-path) view", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "status") return ["# branch.head main", "? new.txt", ""].join("\n");
      return "tracked diff content";
    });
    const noIndexDiff = vi.fn(async () => "untracked diff content");

    const result = await getGitDiff(
      { idempotencyKey: "idem-untracked-2", worktree: "/repo", baseRef: "main" },
      {
        git,
        noIndexDiff,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.inline).toBe("tracked diff content\nuntracked diff content");
  });

  it("shows just the untracked diffs (no leading blank line) when there are no tracked changes at all", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "status") return ["# branch.head main", "? new.txt", ""].join("\n");
      return ""; // no tracked changes vs the base ref
    });
    const noIndexDiff = vi.fn(async () => "untracked diff content");

    const result = await getGitDiff(
      { idempotencyKey: "idem-untracked-3", worktree: "/repo", baseRef: "main" },
      {
        git,
        noIndexDiff,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.inline).toBe("untracked diff content");
  });

  it("never consults noIndexDiff for a tracked path, or when there are no untracked files at all", async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === "status") return ["# branch.head main", ""].join("\n");
      return `diff against ${args.join(" ")}`;
    });
    const noIndexDiff = vi.fn(async () => "should never be called");

    await getGitDiff(
      { idempotencyKey: "idem-untracked-4", worktree: "/repo", baseRef: "main", path: "src/a.ts" },
      {
        git,
        noIndexDiff,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(noIndexDiff).not.toHaveBeenCalled();
  });

  it("truncates a diff exceeding the inline byte budget and sets truncated: true", async () => {
    const bigDiff = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const git = vi.fn(async () => bigDiff);

    const result = await getGitDiff(
      { idempotencyKey: "idem-5", worktree: "/repo", baseRef: "main" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        maxInlineBytes: 50,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.inline).toBeDefined();
    expect(Buffer.byteLength(result.inline as string, "utf8")).toBeLessThanOrEqual(120);
    expect(result.inline).toContain("truncated");
    expect(result.blobRef).toBeUndefined();
  });

  it("uploads the full untruncated diff as a blob and sets blobRef when the diff was truncated", async () => {
    const bigDiff = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const git = vi.fn(async () => bigDiff);
    const uploadBlob = vi.fn(async (plaintext: Uint8Array) => {
      expect(new TextDecoder().decode(plaintext)).toBe(bigDiff);
      return "blob-123";
    });

    const result = await getGitDiff(
      { idempotencyKey: "idem-10", worktree: "/repo", baseRef: "main" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        maxInlineBytes: 50,
        uploadBlob,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
    expect(result.blobRef).toBe("blob-123");
    // The truncated inline preview is still served alongside the blobRef.
    expect(result.inline).toContain("truncated");
  });

  it("does not call uploadBlob for a diff that already fits inline", async () => {
    const git = vi.fn(async () => "small diff");
    const uploadBlob = vi.fn(async () => "blob-should-not-be-called");

    const result = await getGitDiff(
      { idempotencyKey: "idem-11", worktree: "/repo", baseRef: "main" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        uploadBlob,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(uploadBlob).not.toHaveBeenCalled();
    expect(result.blobRef).toBeUndefined();
  });

  it("leaves blobRef unset when uploadBlob resolves null (best-effort failure)", async () => {
    const bigDiff = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const git = vi.fn(async () => bigDiff);
    const uploadBlob = vi.fn(async () => null);

    const result = await getGitDiff(
      { idempotencyKey: "idem-12", worktree: "/repo", baseRef: "main" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        maxInlineBytes: 50,
        uploadBlob,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result.truncated).toBe(true);
    expect(result.blobRef).toBeUndefined();
  });

  it("does not truncate a diff within the inline byte budget", async () => {
    const git = vi.fn(async () => "small diff");

    const result = await getGitDiff(
      { idempotencyKey: "idem-6", worktree: "/repo", baseRef: "main" },
      {
        git,
        resolveConfiguredBaseRef: async () => undefined,
        assertWorkspaceValid: skipWorkspaceValidation,
      },
    );

    expect(result).toEqual({ inline: "small diff", truncated: false });
  });

  it("rejects a baseRef that looks like a git option (e.g. `--output=...`) instead of passing it through", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);

    await expect(
      getGitDiff(
        { idempotencyKey: "idem-8", worktree: "/repo", baseRef: "--output=/tmp/pwned" },
        {
          git,
          resolveConfiguredBaseRef: async () => undefined,
          assertWorkspaceValid: skipWorkspaceValidation,
        },
      ),
    ).rejects.toThrow("unsafe base ref");
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects an unsafe configured base ref the same way as an explicit one", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);

    await expect(
      getGitDiff(
        { idempotencyKey: "idem-9", worktree: "/repo" },
        {
          git,
          resolveConfiguredBaseRef: async () => "-x",
          assertWorkspaceValid: skipWorkspaceValidation,
        },
      ),
    ).rejects.toThrow("unsafe base ref");
    expect(git).not.toHaveBeenCalled();
  });

  it("propagates a git failure (e.g. unknown baseRef) rather than returning an empty diff", async () => {
    const git = vi.fn(async () => {
      throw new Error("fatal: bad revision 'nonexistent-ref'");
    });

    await expect(
      getGitDiff(
        { idempotencyKey: "idem-7", worktree: "/repo", baseRef: "nonexistent-ref" },
        {
          git,
          resolveConfiguredBaseRef: async () => undefined,
          assertWorkspaceValid: skipWorkspaceValidation,
        },
      ),
    ).rejects.toThrow("bad revision");
  });

  it("propagates a WorkspaceValidationError from assertWorkspaceValid without ever calling git (known-issues.md #3)", async () => {
    const git = vi.fn(async () => "diff");

    await expect(
      getGitDiff(
        { idempotencyKey: "idem-13", worktree: "/gone" },
        {
          git,
          resolveConfiguredBaseRef: async () => undefined,
          assertWorkspaceValid: async () => {
            throw new WorkspaceValidationError(
              "workspace is no longer a git repository: /gone",
              "workspace-not-a-repo",
            );
          },
        },
      ),
    ).rejects.toMatchObject({ name: "WorkspaceValidationError", code: "workspace-not-a-repo" });
    expect(git).not.toHaveBeenCalled();
  });

  it("checks the workspace's real filesystem state by default when no override is given", async () => {
    const git = vi.fn(async () => "diff");

    await expect(
      getGitDiff(
        { idempotencyKey: "idem-14", worktree: "/definitely/does/not/exist/anywhere" },
        { git, resolveConfiguredBaseRef: async () => undefined },
      ),
    ).rejects.toMatchObject({ name: "WorkspaceValidationError", code: "workspace-missing" });
  });
});
