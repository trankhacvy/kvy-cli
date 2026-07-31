import { describe, expect, it } from "vitest";
import {
  GIT_EMPTY_TREE_HASH,
  hasAnyCommits,
  resolveDiffBaseline,
  resolveEffectiveBaseRef,
} from "./gitBaseRef.js";

function fakeGit(behavior: (args: string[]) => string) {
  return async (args: string[], _cwd: string) => behavior(args);
}

function fakeGitVerifyOnly(existingBranches: string[]) {
  return async (args: string[], _cwd: string) => {
    const ref = args[args.length - 1] ?? "";
    const branch = ref.replace(/^refs\/heads\//, "");
    if (args[0] === "rev-parse" && !existingBranches.includes(branch)) {
      throw new Error(`fatal: ambiguous argument '${ref}'`);
    }
    return "";
  };
}

describe("resolveEffectiveBaseRef", () => {
  it("prefers an explicit baseRef over everything else", async () => {
    const result = await resolveEffectiveBaseRef("/repo", "some-branch", {
      resolveConfiguredBaseRef: async () => "configured-branch",
      git: fakeGitVerifyOnly(["main"]),
    });
    expect(result).toBe("some-branch");
  });

  it("falls back to the workspace's configured base ref", async () => {
    const result = await resolveEffectiveBaseRef("/repo", undefined, {
      resolveConfiguredBaseRef: async () => "develop",
      git: fakeGitVerifyOnly(["main"]),
    });
    expect(result).toBe("develop");
  });

  it("falls back to a local main branch when nothing is configured", async () => {
    const result = await resolveEffectiveBaseRef("/repo", undefined, {
      resolveConfiguredBaseRef: async () => undefined,
      git: fakeGitVerifyOnly(["main"]),
    });
    expect(result).toBe("main");
  });

  it("falls back to a local master branch when main doesn't exist", async () => {
    const result = await resolveEffectiveBaseRef("/repo", undefined, {
      resolveConfiguredBaseRef: async () => undefined,
      git: fakeGitVerifyOnly(["master"]),
    });
    expect(result).toBe("master");
  });

  it("returns undefined when nothing configured and neither main nor master exists locally", async () => {
    const result = await resolveEffectiveBaseRef("/repo", undefined, {
      resolveConfiguredBaseRef: async () => undefined,
      git: fakeGitVerifyOnly([]),
    });
    expect(result).toBeUndefined();
  });
});

describe("hasAnyCommits", () => {
  it("is true once HEAD resolves", async () => {
    expect(
      await hasAnyCommits(
        "/repo",
        fakeGit(() => ""),
      ),
    ).toBe(true);
  });

  it("is false for an unborn HEAD (fresh repo, no commits)", async () => {
    const git = fakeGit(() => {
      throw new Error("fatal: ambiguous argument 'HEAD'");
    });
    expect(await hasAnyCommits("/repo", git)).toBe(false);
  });
});

describe("resolveDiffBaseline", () => {
  it("is HEAD once the repo has a commit", async () => {
    expect(
      await resolveDiffBaseline(
        "/repo",
        fakeGit(() => ""),
      ),
    ).toBe("HEAD");
  });

  it("is the git empty-tree hash for a repo with no commits yet", async () => {
    const git = fakeGit(() => {
      throw new Error("fatal: ambiguous argument 'HEAD'");
    });
    expect(await resolveDiffBaseline("/repo", git)).toBe(GIT_EMPTY_TREE_HASH);
  });
});
