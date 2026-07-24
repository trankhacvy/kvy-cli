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

  it("falls back to `git diff HEAD` when neither params.baseRef nor a configured base ref exist", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);
    const resolveConfiguredBaseRef = vi.fn(async () => undefined);

    await getGitDiff(
      { idempotencyKey: "idem-3", worktree: "/repo" },
      { git, resolveConfiguredBaseRef, assertWorkspaceValid: skipWorkspaceValidation },
    );

    expect(git).toHaveBeenCalledWith(["diff", "HEAD"], "/repo");
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
