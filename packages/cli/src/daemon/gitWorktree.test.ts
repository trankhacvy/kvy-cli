import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBranchWorkspace, type GitExec, GitWorktreeError } from "./gitWorktree.js";

describe("ensureBranchWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "falcon-git-worktree-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("checks out a new branch in place when createWorktree is false and the branch is new", async () => {
    const git = vi.fn<GitExec>(async (args: string[]) => {
      if (args[0] === "show-ref") throw new Error("not found");
      return "";
    });

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "feature/x", createWorktree: false } },
      { git },
    );

    expect(result).toEqual({ directory: root, createdWorktree: false });
    expect(git).toHaveBeenCalledWith(
      ["show-ref", "--verify", "--quiet", "refs/heads/feature/x"],
      root,
    );
    expect(git).toHaveBeenCalledWith(["checkout", "-b", "feature/x"], root);
  });

  it("checks out an existing branch (no -b) when createWorktree is false and the branch already exists", async () => {
    const git = vi.fn<GitExec>(async () => "");

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "main", createWorktree: false } },
      { git },
    );

    expect(git).toHaveBeenCalledWith(["checkout", "main"], root);
    expect(result.createdWorktree).toBe(false);
  });

  it("creates a new worktree at <repo>/.worktrees/<branch> with -b for a new branch", async () => {
    const git = vi.fn<GitExec>(async (args: string[]) => {
      if (args[0] === "show-ref") throw new Error("not found");
      return "";
    });

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
      { git },
    );

    const expectedDir = path.join(root, ".worktrees", "task-1");
    expect(result).toEqual({ directory: expectedDir, createdWorktree: true });
    expect(git).toHaveBeenCalledWith(["worktree", "add", expectedDir, "-b", "task-1"], root);
  });

  it("adds a worktree without -b when the branch already exists", async () => {
    const git = vi.fn<GitExec>(async () => "");

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "existing-branch", createWorktree: true } },
      { git },
    );

    const expectedDir = path.join(root, ".worktrees", "existing-branch");
    expect(git).toHaveBeenCalledWith(["worktree", "add", expectedDir, "existing-branch"], root);
    expect(result).toEqual({ directory: expectedDir, createdWorktree: true });
  });

  it("is idempotent: reuses an existing worktree directory without calling git again, and reports createdWorktree: false", async () => {
    const worktreeDir = path.join(root, ".worktrees", "task-1");
    await mkdir(worktreeDir, { recursive: true });
    const git = vi.fn<GitExec>(async () => "");

    const result = await ensureBranchWorkspace(
      { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
      { git },
    );

    expect(result).toEqual({ directory: worktreeDir, createdWorktree: false });
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects a branch name that could path-escape .worktrees/", async () => {
    const git = vi.fn<GitExec>(async () => "");
    await expect(
      ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "../../etc", createWorktree: true } },
        { git },
      ),
    ).rejects.toThrow(GitWorktreeError);
    expect(git).not.toHaveBeenCalled();
  });

  it("propagates a git failure as GitWorktreeError", async () => {
    const git = vi.fn<GitExec>(async () => {
      throw new Error("fatal: not a git repository");
    });
    await expect(
      ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: false } },
        { git },
      ),
    ).rejects.toThrow(/not a git repository/);
  });

  describe("base-branch picker (docs/competitive-notes-omnara.md #16)", () => {
    it("passes `from` as the start-point of `checkout -b` when creating a new branch in place", async () => {
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "feature/x", createWorktree: false, from: "main" } },
        { git },
      );

      expect(git).toHaveBeenCalledWith(["checkout", "-b", "feature/x", "main"], root);
    });

    it("passes `from` as the start-point of `worktree add -b` when creating a new branch in a fresh worktree", async () => {
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });

      const result = await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: true, from: "develop" } },
        { git },
      );

      const expectedDir = path.join(root, ".worktrees", "task-1");
      expect(result).toEqual({ directory: expectedDir, createdWorktree: true });
      expect(git).toHaveBeenCalledWith(
        ["worktree", "add", expectedDir, "-b", "task-1", "develop"],
        root,
      );
    });

    it("omits the start-point argument entirely when `from` is undefined (unchanged pre-existing behavior)", async () => {
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "feature/x", createWorktree: false } },
        { git },
      );

      expect(git).toHaveBeenCalledWith(["checkout", "-b", "feature/x"], root);
    });

    it("omits the start-point argument when `from` is a blank string", async () => {
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        return "";
      });

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "feature/x", createWorktree: false, from: "   " } },
        { git },
      );

      expect(git).toHaveBeenCalledWith(["checkout", "-b", "feature/x"], root);
    });

    it("ignores `from` when the branch already exists (no base ref to speak of)", async () => {
      const git = vi.fn<GitExec>(async () => "");

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "main", createWorktree: false, from: "develop" } },
        { git },
      );

      expect(git).toHaveBeenCalledWith(["checkout", "main"], root);
    });
  });

  describe("checked-out-elsewhere guard (docs/features/worktree-isolation.md Phase 3)", () => {
    it("throws a typed error instead of running `worktree add` when the branch is already checked out in a different worktree", async () => {
      const otherWorktree = path.join(root, "elsewhere");
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") return ""; // branch exists
        if (args[0] === "for-each-ref") return `${otherWorktree}\n`;
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      });

      await expect(
        ensureBranchWorkspace(
          { repoDirectory: root, branch: { name: "shared-branch", createWorktree: true } },
          { git },
        ),
      ).rejects.toThrow(/shared-branch.*already checked out at.*elsewhere/);
      expect(git).not.toHaveBeenCalledWith(
        expect.arrayContaining(["worktree", "add"]),
        expect.anything(),
      );
    });

    it("throws the same typed error on the in-place checkout path (createWorktree: false)", async () => {
      const otherWorktree = path.join(root, ".worktrees", "shared-branch");
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") return "";
        if (args[0] === "for-each-ref") return `${otherWorktree}\n`;
        throw new Error(`unexpected git call: ${args.join(" ")}`);
      });

      await expect(
        ensureBranchWorkspace(
          { repoDirectory: root, branch: { name: "shared-branch", createWorktree: false } },
          { git },
        ),
      ).rejects.toThrow(GitWorktreeError);
      expect(git).not.toHaveBeenCalledWith(["checkout", "shared-branch"], root);
    });

    it("does not throw when the branch is already checked out at the exact target worktree directory (idempotent reuse)", async () => {
      const expectedDir = path.join(root, ".worktrees", "task-1");
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") return "";
        if (args[0] === "for-each-ref") return `${expectedDir}\n`;
        return "";
      });

      const result = await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
        { git },
      );
      expect(result).toEqual({ directory: expectedDir, createdWorktree: true });
      expect(git).toHaveBeenCalledWith(["worktree", "add", expectedDir, "task-1"], root);
    });
  });

  describe("idempotent .git/info/exclude entry (docs/features/worktree-isolation.md Phase 3)", () => {
    it("adds '.worktrees/' to a fresh .git/info/exclude after creating a worktree", async () => {
      await mkdir(path.join(root, ".git", "info"), { recursive: true });
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        if (args[0] === "for-each-ref") return "";
        return "";
      });

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
        { git },
      );

      const contents = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
      expect(contents).toBe(".worktrees/\n");
    });

    it("only gains the '.worktrees/' line once across two calls", async () => {
      await mkdir(path.join(root, ".git", "info"), { recursive: true });
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        if (args[0] === "for-each-ref") return "";
        return "";
      });

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
        { git },
      );
      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-2", createWorktree: true } },
        { git },
      );

      const contents = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
      expect(contents.split("\n").filter((line) => line.trim() === ".worktrees/")).toHaveLength(1);
    });

    it("preserves existing exclude content and appends on its own line", async () => {
      await mkdir(path.join(root, ".git", "info"), { recursive: true });
      await writeFile(path.join(root, ".git", "info", "exclude"), "*.log", "utf8");
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        if (args[0] === "for-each-ref") return "";
        return "";
      });

      await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
        { git },
      );

      const contents = await readFile(path.join(root, ".git", "info", "exclude"), "utf8");
      expect(contents).toBe("*.log\n.worktrees/\n");
    });

    it("does not fail the spawn when .git isn't a directory (repoDirectory is itself a worktree)", async () => {
      await writeFile(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/task-1", "utf8");
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        if (args[0] === "for-each-ref") return "";
        return "";
      });

      const result = await ensureBranchWorkspace(
        { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
        { git },
      );
      expect(result).toEqual({
        directory: path.join(root, ".worktrees", "task-1"),
        createdWorktree: true,
      });
    });

    it("does not reject when the exclude write itself fails", async () => {
      // No `.git` directory at all in `root` — `stat` throws, caught silently.
      const git = vi.fn<GitExec>(async (args: string[]) => {
        if (args[0] === "show-ref") throw new Error("not found");
        if (args[0] === "for-each-ref") return "";
        return "";
      });

      await expect(
        ensureBranchWorkspace(
          { repoDirectory: root, branch: { name: "task-1", createWorktree: true } },
          { git },
        ),
      ).resolves.toEqual({
        directory: path.join(root, ".worktrees", "task-1"),
        createdWorktree: true,
      });
    });
  });
});
