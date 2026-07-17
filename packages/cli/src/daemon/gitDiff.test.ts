import { describe, expect, it, vi } from "vitest";
import { getGitDiff } from "./gitDiff.js";

describe("getGitDiff", () => {
  it("uses an explicit baseRef when given, without consulting the configured resolver", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);
    const resolveConfiguredBaseRef = vi.fn(async () => "configured-base");

    const result = await getGitDiff(
      { idempotencyKey: "idem-1", worktree: "/repo", baseRef: "explicit-base" },
      { git, resolveConfiguredBaseRef },
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
      { git, resolveConfiguredBaseRef },
    );

    expect(git).toHaveBeenCalledWith(["diff", "develop"], "/repo");
  });

  it("falls back to `git diff HEAD` when neither params.baseRef nor a configured base ref exist", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);
    const resolveConfiguredBaseRef = vi.fn(async () => undefined);

    await getGitDiff(
      { idempotencyKey: "idem-3", worktree: "/repo" },
      { git, resolveConfiguredBaseRef },
    );

    expect(git).toHaveBeenCalledWith(["diff", "HEAD"], "/repo");
  });

  it("scopes the diff to a single path when params.path is given", async () => {
    const git = vi.fn(async (args: string[]) => `diff against ${args.join(" ")}`);

    await getGitDiff(
      { idempotencyKey: "idem-4", worktree: "/repo", baseRef: "main", path: "src/a.ts" },
      { git, resolveConfiguredBaseRef: async () => undefined },
    );

    expect(git).toHaveBeenCalledWith(["diff", "main", "--", "src/a.ts"], "/repo");
  });

  it("truncates a diff exceeding the inline byte budget and sets truncated: true", async () => {
    const bigDiff = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join("\n");
    const git = vi.fn(async () => bigDiff);

    const result = await getGitDiff(
      { idempotencyKey: "idem-5", worktree: "/repo", baseRef: "main" },
      { git, resolveConfiguredBaseRef: async () => undefined, maxInlineBytes: 50 },
    );

    expect(result.truncated).toBe(true);
    expect(result.inline).toBeDefined();
    expect(Buffer.byteLength(result.inline as string, "utf8")).toBeLessThanOrEqual(120);
    expect(result.inline).toContain("truncated");
    expect(result.blobRef).toBeUndefined();
  });

  it("does not truncate a diff within the inline byte budget", async () => {
    const git = vi.fn(async () => "small diff");

    const result = await getGitDiff(
      { idempotencyKey: "idem-6", worktree: "/repo", baseRef: "main" },
      { git, resolveConfiguredBaseRef: async () => undefined },
    );

    expect(result).toEqual({ inline: "small diff", truncated: false });
  });

  it("propagates a git failure (e.g. unknown baseRef) rather than returning an empty diff", async () => {
    const git = vi.fn(async () => {
      throw new Error("fatal: bad revision 'nonexistent-ref'");
    });

    await expect(
      getGitDiff(
        { idempotencyKey: "idem-7", worktree: "/repo", baseRef: "nonexistent-ref" },
        { git, resolveConfiguredBaseRef: async () => undefined },
      ),
    ).rejects.toThrow("bad revision");
  });
});
