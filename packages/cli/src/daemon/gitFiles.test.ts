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

  it("propagates a git failure as GitExecError", async () => {
    const git = vi.fn(async () => {
      throw new GitExecError("fatal: not a git repository");
    });
    await expect(getGitFiles(PARAMS, { git })).rejects.toThrow(GitExecError);
  });
});
