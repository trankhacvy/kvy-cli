import type { GitRemoteInfo, GitStatusResult } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import { derivePushReadiness, PUSH_READINESS_COPY } from "./push-readiness";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return { branch: "main", ahead: 0, behind: 0, files: [], ...overrides };
}

describe("derivePushReadiness", () => {
  it("is unknown while remotes haven't loaded yet, even with a resolved status", () => {
    expect(derivePushReadiness(status(), undefined, [])).toBe("unknown");
  });

  it("is unknown while status hasn't loaded yet, even with resolved remotes", () => {
    expect(derivePushReadiness(undefined, [], [])).toBe("unknown");
  });

  it("is no-remote when remotes resolved to an empty array", () => {
    expect(derivePushReadiness(status(), [], [])).toBe("no-remote");
  });

  it("is detached when status.branch is the literal '(detached)' marker, checked before remotes", () => {
    const remotes: GitRemoteInfo[] = [];
    expect(derivePushReadiness(status({ branch: "(detached)" }), remotes, [])).toBe("detached");
  });

  it("is detached when status.branch is empty, even with a non-empty remotes list", () => {
    const remotes: GitRemoteInfo[] = [{ name: "origin", url: "git@github.com:a/b.git" }];
    expect(derivePushReadiness(status({ branch: "" }), remotes, [])).toBe("detached");
  });

  it("is no-upstream when the current branch has no configured upstream", () => {
    const remotes: GitRemoteInfo[] = [{ name: "origin", url: "git@github.com:a/b.git" }];
    const branches = [{ name: "main", isCurrent: true }];
    expect(derivePushReadiness(status(), remotes, branches)).toBe("no-upstream");
  });

  it("is ready when a remote exists and the current branch has an upstream", () => {
    const remotes: GitRemoteInfo[] = [{ name: "origin", url: "git@github.com:a/b.git" }];
    const branches = [{ name: "main", isCurrent: true, upstream: "origin/main" }];
    expect(derivePushReadiness(status(), remotes, branches)).toBe("ready");
  });

  it("is ready when no branch in the list is flagged current (nothing to warn about)", () => {
    const remotes: GitRemoteInfo[] = [{ name: "origin", url: "git@github.com:a/b.git" }];
    const branches = [{ name: "other", isCurrent: false }];
    expect(derivePushReadiness(status(), remotes, branches)).toBe("ready");
  });
});

describe("PUSH_READINESS_COPY", () => {
  it("has no entry for ready/unknown — they render nothing", () => {
    expect(PUSH_READINESS_COPY.ready).toBeUndefined();
    expect(PUSH_READINESS_COPY.unknown).toBeUndefined();
  });

  it("has an entry for every blocked state", () => {
    expect(PUSH_READINESS_COPY["no-remote"]).toBeTruthy();
    expect(PUSH_READINESS_COPY.detached).toBeTruthy();
  });

  it("contains no internal vocabulary (CLAUDE.md auth/UX rule #4)", () => {
    for (const value of Object.values(PUSH_READINESS_COPY)) {
      expect(value).not.toMatch(
        /keyEpoch|masterSecret|\bbind\b|custody|bridge|\bepoch\b|\bDEK\b|nonce|ephPub/i,
      );
    }
  });
});
