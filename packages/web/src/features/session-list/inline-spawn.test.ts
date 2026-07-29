import { describe, expect, it } from "vitest";
import type { BranchItem, ImportCandidate } from "../new-session";
import {
  buildInlineSpawnRequest,
  canStartInlineSpawn,
  deriveDefaultBaseBranch,
  type InlineSpawnForm,
  translateSpawnError,
} from "./inline-spawn";

function form(overrides: Partial<InlineSpawnForm> = {}): InlineSpawnForm {
  return {
    provider: "claude-code",
    permissionMode: "default",
    model: "",
    baseBranch: "",
    branchName: "wf/20260722-a3f9",
    continueFrom: null,
    ...overrides,
  };
}

describe("deriveDefaultBaseBranch", () => {
  it("returns the isCurrent branch's name when branches have loaded", () => {
    const branches: BranchItem[] = [
      { name: "main", isCurrent: false },
      { name: "develop", isCurrent: true },
    ];
    expect(deriveDefaultBaseBranch(branches)).toBe("develop");
  });

  it('falls back to "main" when branches is null (not loaded yet)', () => {
    expect(deriveDefaultBaseBranch(null)).toBe("main");
  });

  it('falls back to "main" when no branch is marked current', () => {
    const branches: BranchItem[] = [{ name: "feature-x", isCurrent: false }];
    expect(deriveDefaultBaseBranch(branches)).toBe("main");
  });

  it('falls back to "main" for an empty branch list', () => {
    expect(deriveDefaultBaseBranch([])).toBe("main");
  });

  it("prefers a configured baseRef over the isCurrent branch", () => {
    const branches: BranchItem[] = [{ name: "develop", isCurrent: true }];
    expect(deriveDefaultBaseBranch(branches, "release")).toBe("release");
  });

  it("ignores a blank/whitespace-only configured baseRef and falls through to isCurrent", () => {
    const branches: BranchItem[] = [{ name: "develop", isCurrent: true }];
    expect(deriveDefaultBaseBranch(branches, "   ")).toBe("develop");
  });

  it('falls through configured baseRef -> isCurrent -> "main" in priority order', () => {
    expect(deriveDefaultBaseBranch(null, undefined)).toBe("main");
    expect(deriveDefaultBaseBranch([{ name: "develop", isCurrent: true }], undefined)).toBe(
      "develop",
    );
    expect(deriveDefaultBaseBranch([{ name: "develop", isCurrent: true }], "release")).toBe(
      "release",
    );
  });
});

describe("buildInlineSpawnRequest", () => {
  it("always sets branch.createWorktree to true", () => {
    const request = buildInlineSpawnRequest("/repo", form());
    expect(request.branch?.createWorktree).toBe(true);
  });

  it("trims and carries the branch name through", () => {
    const request = buildInlineSpawnRequest("/repo", form({ branchName: "  wf/foo  " }));
    expect(request.branch?.name).toBe("wf/foo");
  });

  it("omits `from` when baseBranch is blank", () => {
    const request = buildInlineSpawnRequest("/repo", form({ baseBranch: "" }));
    expect(request.branch?.from).toBeUndefined();
  });

  it("sets `from` to the trimmed baseBranch when one is picked", () => {
    const request = buildInlineSpawnRequest("/repo", form({ baseBranch: " main " }));
    expect(request.branch?.from).toBe("main");
  });

  it('omits `model` when blank, translating "" to "use provider default"', () => {
    const request = buildInlineSpawnRequest("/repo", form({ model: "" }));
    expect(request.model).toBeUndefined();
  });

  it("trims a custom model string through", () => {
    const request = buildInlineSpawnRequest("/repo", form({ model: " sonnet " }));
    expect(request.model).toBe("sonnet");
  });

  it("carries provider/permissionMode/directory straight through", () => {
    const request = buildInlineSpawnRequest("/repo/path", form({ provider: "codex" }));
    expect(request.directory).toBe("/repo/path");
    expect(request.provider).toBe("codex");
    expect(request.permissionMode).toBe("default");
  });

  it("sets continueFrom when a candidate was picked", () => {
    const candidate: ImportCandidate = {
      providerSessionId: "prov-1",
      lastActivityAt: 0,
    };
    const request = buildInlineSpawnRequest("/repo", form({ continueFrom: candidate }));
    expect(request.continueFrom).toEqual({ providerSessionId: "prov-1" });
  });

  it("omits continueFrom when starting fresh", () => {
    const request = buildInlineSpawnRequest("/repo", form({ continueFrom: null }));
    expect(request.continueFrom).toBeUndefined();
  });
});

describe("canStartInlineSpawn", () => {
  it("is true once a branch name is present", () => {
    expect(canStartInlineSpawn(form({ branchName: "wf/x" }))).toBe(true);
  });

  it("is false for a blank branch name", () => {
    expect(canStartInlineSpawn(form({ branchName: "" }))).toBe(false);
  });

  it("is false for a whitespace-only branch name", () => {
    expect(canStartInlineSpawn(form({ branchName: "   " }))).toBe(false);
  });
});

describe("translateSpawnError", () => {
  it("translates the flat spawnAwaiter timeout without leaking the pid or the webhook route", () => {
    const raw =
      "spawn launched (pid 4821, tmux) but spawned process (pid 4821) did not report back via /session-started within 15000ms";
    const message = translateSpawnError(raw);
    expect(message).not.toMatch(/pid/i);
    expect(message).not.toContain("/session-started");
    expect(message).toMatch(/timed out/i);
  });

  it("translates a crashed-before-reporting exit without leaking the pid", () => {
    const raw =
      "spawn launched (pid 991, detached) but spawned process (pid 991) exited before it reported starting (exit code 1, signal null)";
    const message = translateSpawnError(raw);
    expect(message).not.toMatch(/pid/i);
    expect(message).toMatch(/exited before it could start/i);
  });

  it("translates a quota/429 startup-failure self-report into plain language", () => {
    const raw =
      "spawn launched (pid 100, tmux) but spawned process (pid 100) reported a startup failure: 429 session quota exceeded";
    const message = translateSpawnError(raw);
    expect(message).not.toMatch(/pid/i);
    expect(message).toMatch(/session limit/i);
  });

  it("translates an adapter-not-installed startup-failure self-report", () => {
    const raw =
      "spawn launched (pid 100, tmux) but spawned process (pid 100) reported a startup failure: ACP adapter codex-acp is not-installed";
    const message = translateSpawnError(raw);
    expect(message).toMatch(/adapter/i);
    expect(message).not.toMatch(/pid/i);
  });

  it("translates an unrecognized startup-failure self-report by surfacing the inner reason", () => {
    const raw =
      "spawn launched (pid 100, tmux) but spawned process (pid 100) reported a startup failure: something unusual happened";
    const message = translateSpawnError(raw);
    expect(message).toContain("something unusual happened");
    expect(message).not.toMatch(/pid/i);
  });

  it("translates a branch/worktree setup failure", () => {
    const raw = 'branch/worktree setup failed: unsafe branch name: ""';
    const message = translateSpawnError(raw);
    expect(message).toMatch(/branch\/worktree/i);
  });

  it("translates a provider-process launch failure", () => {
    const raw = "failed to launch provider process: ENOENT";
    const message = translateSpawnError(raw);
    expect(message).toMatch(/couldn't launch/i);
    expect(message).toContain("ENOENT");
  });

  it("translates the (structurally-unreachable-here) workspace-path-rejected reason honestly", () => {
    const raw = "workspace path rejected (outside-workspace-root): /tmp/evil";
    const message = translateSpawnError(raw);
    expect(message).toMatch(/couldn't be validated/i);
  });

  it("scrubs a raw pid and webhook route name from any unrecognized message shape", () => {
    const raw = "some future daemon error mentioning (pid 555) and /session-started directly";
    const message = translateSpawnError(raw);
    expect(message).not.toMatch(/pid \d+/i);
    expect(message).not.toContain("/session-started");
  });
});
