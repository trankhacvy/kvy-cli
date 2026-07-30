import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitExecError, runGit, runGitDiffNoIndex } from "./gitExec.js";

/**
 * Unlike every other `daemon/git*.test.ts` suite (which fakes `GitExec` and
 * never touches the real `git` binary), this file exercises `runGit`
 * against a real temp repo — the only way to catch a mismatch between what
 * a caller (`gitCommit.ts`'s `NOTHING_TO_COMMIT_RE`) expects `GitExecError`'s
 * message to contain and what `git` actually writes, and to which stream.
 */
describe("runGit (real git binary)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "falcon-git-exec-"));
    await runGit(["init"], repo);
    await runGit(["config", "user.email", "test@example.com"], repo);
    await runGit(["config", "user.name", "Test"], repo);
    await writeFile(path.join(repo, "a.txt"), "hello\n");
    await runGit(["add", "-A"], repo);
    await runGit(["commit", "-m", "initial"], repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("resolves with stdout on success", async () => {
    const output = await runGit(["rev-parse", "HEAD"], repo);
    expect(output.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects with git's actual message when it writes to stderr (fatal error)", async () => {
    const notARepo = await mkdtemp(path.join(tmpdir(), "falcon-git-exec-norepo-"));
    try {
      await expect(runGit(["status"], notARepo)).rejects.toThrow(/not a git repository/);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });

  it("rejects with git's real 'nothing to commit' message even though git writes it to STDOUT, not stderr (regression: the message must not be swallowed as a generic 'Command failed' string)", async () => {
    // The working tree is already clean (nothing changed since the initial
    // commit in beforeEach) — `git commit` exits non-zero and prints
    // "nothing to commit, working tree clean" to stdout.
    await expect(runGit(["commit", "-m", "no-op"], repo)).rejects.toThrow(GitExecError);
    await expect(runGit(["commit", "-m", "no-op"], repo)).rejects.toThrow(
      /nothing to commit|working tree clean/,
    );
  });
});

describe("runGitDiffNoIndex (real git binary)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "falcon-git-exec-noindex-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("resolves with the diff even though git exits 1 when the two sides differ", async () => {
    await writeFile(path.join(repo, "new.txt"), "hello\n");
    const output = await runGitDiffNoIndex(
      ["diff", "--no-index", "--", "/dev/null", "new.txt"],
      repo,
    );
    expect(output).toContain("+hello");
    expect(output).toContain("new.txt");
  });

  it("rejects on a real error (e.g. a nonexistent path on both sides)", async () => {
    await expect(
      runGitDiffNoIndex(["diff", "--no-index", "--", "/dev/null", "does-not-exist.txt"], repo),
    ).rejects.toThrow(GitExecError);
  });
});
