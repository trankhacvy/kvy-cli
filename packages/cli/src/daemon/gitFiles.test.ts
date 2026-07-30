import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { getGitFiles } from "./gitFiles.js";

const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

describe("getGitFiles", () => {
  it("parses ls-files output into a sorted, non-empty file list", async () => {
    const git = vi.fn(async () => "src/b.ts\nsrc/a.ts\nREADME.md\n");
    const result = await getGitFiles(PARAMS, { git });

    expect(result).toEqual({ files: ["README.md", "src/a.ts", "src/b.ts"] });
    expect(git).toHaveBeenCalledExactlyOnceWith(
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      "/repo",
    );
  });

  it("skips blank lines", async () => {
    const git = vi.fn(async () => "a.ts\n\nb.ts\n\n");
    const result = await getGitFiles(PARAMS, { git });
    expect(result).toEqual({ files: ["a.ts", "b.ts"] });
  });

  it("returns an empty file list for a repo with no files", async () => {
    const git = vi.fn(async () => "");
    const result = await getGitFiles(PARAMS, { git });
    expect(result).toEqual({ files: [] });
  });

  it("propagates a non-repository git failure as GitExecError", async () => {
    const git = vi.fn(async () => {
      throw new GitExecError("fatal: unable to read config file");
    });
    await expect(getGitFiles(PARAMS, { git })).rejects.toThrow(GitExecError);
  });

  it("falls back to a plain directory listing when worktree isn't a git repository", async () => {
    const git = vi.fn(async () => {
      throw new GitExecError("fatal: not a git repository (or any of the parent directories): .git");
    });
    const listPlainFiles = vi.fn(async () => ["b.ts", "a.ts"]);
    const result = await getGitFiles(PARAMS, { git, listPlainFiles });

    expect(result).toEqual({ files: ["a.ts", "b.ts"] });
    expect(listPlainFiles).toHaveBeenCalledExactlyOnceWith("/repo");
  });

  it("the real fallback walk lists files recursively and skips node_modules/.git", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "falcon-gitfiles-"));
    try {
      await writeFile(path.join(dir, "README.md"), "hi");
      await mkdir(path.join(dir, "src"));
      await writeFile(path.join(dir, "src", "index.ts"), "");
      await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "");
      await mkdir(path.join(dir, ".git"));
      await writeFile(path.join(dir, ".git", "HEAD"), "");

      const git = vi.fn(async () => {
        throw new GitExecError(
          "fatal: not a git repository (or any of the parent directories): .git",
        );
      });
      const result = await getGitFiles({ idempotencyKey: "idem-1", worktree: dir }, { git });

      expect(result).toEqual({ files: ["README.md", "src/index.ts"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
