import { describe, expect, it, vi } from "vitest";
import { GitExecError } from "./gitExec.js";
import { removeWorktree } from "./worktreeRemove.js";

const WORKTREE = "/repo/.worktrees/wf/20260722-a3f9";
const MAIN_ROOT = "/repo";
const PARAMS = { idempotencyKey: "idem-1", worktree: WORKTREE };

type StatFn = (path: string) => Promise<unknown>;

/** Authorizer stub: resolves truthy (a registry "entry"-shaped object) — real shape doesn't matter, only truthiness. */
function okAuthorizer() {
  return vi.fn(async () => ({ path: WORKTREE, registeredAt: "now" }));
}

/** Every test besides the dedicated "already-removed" one needs the directory to appear to exist, so `removeWorktree`'s `stat` pre-check doesn't short-circuit before ever reaching git. */
function existingStat(): StatFn {
  return vi.fn(async () => ({ isDirectory: () => true }));
}

/** `git` stub that answers `rev-parse --git-common-dir` with `<MAIN_ROOT>/.git` (the real repo root discovery call every code path makes first) and defers everything else to `rest`. */
function gitWithRootDiscovery(rest: (args: string[], cwd: string) => Promise<string>) {
  return vi.fn(async (args: string[], cwd: string) => {
    if (args[0] === "rev-parse") return `${MAIN_ROOT}/.git\n`;
    return rest(args, cwd);
  });
}

describe("removeWorktree", () => {
  it("removes a clean worktree (success case) without --force", async () => {
    const git = gitWithRootDiscovery(async () => "");
    const result = await removeWorktree(PARAMS, {
      git,
      authorize: okAuthorizer(),
      stat: existingStat() as never,
    });

    expect(result).toEqual({ removed: true });
    expect(git).toHaveBeenCalledWith(["worktree", "remove", WORKTREE], MAIN_ROOT);
  });

  it("discovers the real repo root by running git IN the worktree itself, not assuming a fixed path shape", async () => {
    const git = gitWithRootDiscovery(async () => "");
    await removeWorktree(PARAMS, { git, authorize: okAuthorizer(), stat: existingStat() as never });

    expect(git).toHaveBeenCalledWith(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      WORKTREE,
    );
  });

  it("surfaces uncommitted/untracked changes as requiresForce:true instead of forcing or silently failing", async () => {
    const git = gitWithRootDiscovery(async (args) => {
      if (args[0] === "worktree" && !args.includes("--force")) {
        throw new GitExecError(
          `fatal: '${WORKTREE}' contains modified or untracked files, use --force to delete it`,
        );
      }
      return "";
    });

    const result = await removeWorktree(PARAMS, {
      git,
      authorize: okAuthorizer(),
      stat: existingStat() as never,
    });
    expect(result).toEqual({ removed: false, requiresForce: true });
  });

  it("retries with --force and succeeds when the caller explicitly confirms force:true", async () => {
    const git = gitWithRootDiscovery(async (args) => {
      if (args[0] === "worktree" && !args.includes("--force")) {
        throw new GitExecError("contains modified or untracked files, use --force to delete it");
      }
      return "";
    });

    const result = await removeWorktree(
      { ...PARAMS, force: true },
      { git, authorize: okAuthorizer(), stat: existingStat() as never },
    );
    expect(result).toEqual({ removed: true });
    expect(git).toHaveBeenCalledWith(["worktree", "remove", "--force", WORKTREE], MAIN_ROOT);
  });

  it("rethrows any other git failure rather than treating it as a requiresForce case", async () => {
    const git = gitWithRootDiscovery(async (args) => {
      if (args[0] === "worktree") {
        throw new GitExecError(`fatal: '${WORKTREE}' is not a working tree`);
      }
      return "";
    });

    await expect(
      removeWorktree(PARAMS, { git, authorize: okAuthorizer(), stat: existingStat() as never }),
    ).rejects.toThrow("is not a working tree");
  });

  it("throws before touching git at all when the worktree isn't authorized (registered)", async () => {
    const git = vi.fn(async () => "");
    const authorize = vi.fn(async () => null);

    await expect(
      removeWorktree(PARAMS, { git, authorize, stat: existingStat() as never }),
    ).rejects.toThrow(GitExecError);
    expect(git).not.toHaveBeenCalled();
  });

  it("refuses to touch a path with no .worktrees segment even if it IS a registered workspace (repo-root safety guard)", async () => {
    const git = vi.fn(async () => "");
    const authorize = vi.fn(async () => ({ path: "/repo", registeredAt: "now" }));

    await expect(
      removeWorktree(
        { idempotencyKey: "idem-1", worktree: "/repo" },
        { git, authorize, stat: existingStat() as never },
      ),
    ).rejects.toThrow(/doesn't look like a Kvy-managed/);
    // Must reject before ever invoking `git worktree remove` against a real repo root.
    expect(git).not.toHaveBeenCalled();
  });

  it("does not delete the branch when deleteBranch is omitted", async () => {
    const git = gitWithRootDiscovery(async () => "");
    const result = await removeWorktree(PARAMS, {
      git,
      authorize: okAuthorizer(),
      stat: existingStat() as never,
    });
    expect(result.branchDeleted).toBeUndefined();
  });

  it("deletes the branch (derived from the worktree's own path) when deleteBranch is set, as a separate step after removal", async () => {
    const calls: string[][] = [];
    const git = gitWithRootDiscovery(async (args) => {
      calls.push(args);
      return "";
    });

    const result = await removeWorktree(
      { ...PARAMS, deleteBranch: true },
      { git, authorize: okAuthorizer(), stat: existingStat() as never },
    );

    expect(result).toEqual({ removed: true, branchDeleted: true });
    expect(calls).toContainEqual(["branch", "-D", "wf/20260722-a3f9"]);
  });

  it("reports branchDeleted:false (without failing the whole call) when the branch delete itself fails", async () => {
    const git = gitWithRootDiscovery(async (args) => {
      if (args[0] === "branch") throw new GitExecError("error: branch is checked out elsewhere");
      return "";
    });

    const result = await removeWorktree(
      { ...PARAMS, deleteBranch: true },
      { git, authorize: okAuthorizer(), stat: existingStat() as never },
    );
    // The worktree itself was already removed successfully — a branch-delete
    // failure must not erase that (no silent failure, no silent full-throw
    // either — see this module's own doc comment).
    expect(result).toEqual({ removed: true, branchDeleted: false });
  });

  it("treats an already-removed (nonexistent) worktree as a safe no-op success, detected via stat rather than git's error text", async () => {
    const git = vi.fn(async () => "");
    const missingStat: StatFn = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = await removeWorktree(PARAMS, {
      git,
      authorize: okAuthorizer(),
      stat: missingStat as never,
    });

    expect(result).toEqual({ removed: true });
    // Never even asks git anything once the directory is confirmed gone.
    expect(git).not.toHaveBeenCalled();
  });

  it("still throws honestly (not a silent success) when git itself reports the worktree isn't a real linked worktree, despite the directory existing", async () => {
    const git = gitWithRootDiscovery(async (args) => {
      if (args[0] === "worktree") {
        throw new GitExecError(`fatal: '${WORKTREE}' is not a working tree`);
      }
      return "";
    });

    await expect(
      removeWorktree(PARAMS, { git, authorize: okAuthorizer(), stat: existingStat() as never }),
    ).rejects.toThrow("is not a working tree");
  });
});
