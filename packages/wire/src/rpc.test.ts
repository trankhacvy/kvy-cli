import { describe, expect, it } from "vitest";
import {
  AdoptListParamsSchema,
  AdoptMirrorParamsSchema,
  AdoptMirrorResultSchema,
  AdoptTakeParamsSchema,
  AdoptTakeResultSchema,
  FileStatusSchema,
  FsListParamsSchema,
  FsListResultSchema,
  FsMkdirParamsSchema,
  FsMkdirResultSchema,
  FsReadParamsSchema,
  GitBranchesParamsSchema,
  GitBranchesResultSchema,
  GitBranchInfoSchema,
  GitCommitParamsSchema,
  GitCommitResultSchema,
  GitDiffParamsSchema,
  GitDiffResultSchema,
  GitPushParamsSchema,
  GitPushResultSchema,
  GitRenameBranchParamsSchema,
  GitRenameBranchResultSchema,
  GitStatusParamsSchema,
  GitStatusResultSchema,
  MessageRpcResultSchema,
  PermAnswerParamsSchema,
  PermAnswerResultSchema,
  RpcCallSchema,
  SetModeResultSchema,
  SpawnParamsSchema,
  SpawnResultSchema,
  WorkspaceRegisterParamsSchema,
  WorkspaceRegisterResultSchema,
} from "./rpc";

const box = { t: "enc" as const, v: 1 as const, c: "x" };

describe("RpcCallSchema", () => {
  it("accepts a scope-prefixed target", () => {
    const call = { target: "m:machine-1:spawn", method: "spawn", params: box };
    expect(RpcCallSchema.safeParse(call).success).toBe(true);
  });
});

describe("idempotencyKey on caller-retriable machine RPCs", () => {
  it("requires idempotencyKey on spawn/adopt.*/git.*/fs.read", () => {
    expect(
      SpawnParamsSchema.safeParse({
        workspaceId: "w1",
        directory: "/tmp",
        provider: "claude-code",
        permissionMode: "default",
      }).success,
    ).toBe(false);
    expect(
      SpawnParamsSchema.safeParse({
        idempotencyKey: "idem-1",
        workspaceId: "w1",
        directory: "/tmp",
        provider: "claude-code",
        permissionMode: "default",
      }).success,
    ).toBe(true);

    expect(AdoptListParamsSchema.safeParse({ workspaceId: "w1" }).success).toBe(false);
    expect(
      AdoptListParamsSchema.safeParse({ idempotencyKey: "idem-2", workspaceId: "w1" }).success,
    ).toBe(true);

    expect(
      AdoptTakeParamsSchema.safeParse({ providerSessionId: "p1", mode: "takeover" }).success,
    ).toBe(false);
    expect(
      AdoptTakeParamsSchema.safeParse({
        idempotencyKey: "idem-3",
        providerSessionId: "p1",
        mode: "fork",
      }).success,
    ).toBe(true);

    expect(GitStatusParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      GitStatusParamsSchema.safeParse({ idempotencyKey: "idem-4", worktree: "/repo" }).success,
    ).toBe(true);

    expect(GitDiffParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      GitDiffParamsSchema.safeParse({ idempotencyKey: "idem-5", worktree: "/repo" }).success,
    ).toBe(true);

    expect(GitBranchesParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      GitBranchesParamsSchema.safeParse({ idempotencyKey: "idem-8", worktree: "/repo" }).success,
    ).toBe(true);

    expect(FsReadParamsSchema.safeParse({ worktree: "/repo", path: "a.ts" }).success).toBe(false);
    expect(
      FsReadParamsSchema.safeParse({ idempotencyKey: "idem-6", worktree: "/repo", path: "a.ts" })
        .success,
    ).toBe(true);

    expect(AdoptMirrorParamsSchema.safeParse({ providerSessionId: "p1" }).success).toBe(false);
    expect(
      AdoptMirrorParamsSchema.safeParse({ idempotencyKey: "idem-7", providerSessionId: "p1" })
        .success,
    ).toBe(true);
  });
});

describe("adopt.take / adopt.mirror result shapes", () => {
  it("AdoptTakeResultSchema's warning is optional (absent on fork / idle takeover)", () => {
    expect(AdoptTakeResultSchema.safeParse({ sessionId: "s1" }).success).toBe(true);
    expect(
      AdoptTakeResultSchema.safeParse({ sessionId: "s1", warning: "interrupted mid-turn" }).success,
    ).toBe(true);
  });

  it("AdoptMirrorResultSchema accepts a chunk with a nullable nextCursor", () => {
    expect(
      AdoptMirrorResultSchema.safeParse({ chunk: "{}\n", nextCursor: 128, done: false }).success,
    ).toBe(true);
    expect(
      AdoptMirrorResultSchema.safeParse({ chunk: "{}\n", nextCursor: null, done: true }).success,
    ).toBe(true);
  });
});

describe("git.status / git.diff result shapes", () => {
  it("GitStatusResultSchema carries branch/ahead/behind and a list of FileStatus", () => {
    expect(
      GitStatusResultSchema.safeParse({
        branch: "main",
        ahead: 1,
        behind: 0,
        files: [{ path: "src/a.ts", status: "modified" }],
      }).success,
    ).toBe(true);
    expect(FileStatusSchema.safeParse({ path: "src/b.ts", status: "untracked" }).success).toBe(
      true,
    );
    expect(FileStatusSchema.safeParse({ path: "src/b.ts", status: "bogus" }).success).toBe(false);
  });

  it("GitDiffResultSchema requires `truncated`; `inline`/`blobRef` stay optional", () => {
    expect(GitDiffResultSchema.safeParse({ inline: "diff --git a/x b/x" }).success).toBe(false);
    expect(
      GitDiffResultSchema.safeParse({ inline: "diff --git a/x b/x", truncated: false }).success,
    ).toBe(true);
    expect(GitDiffResultSchema.safeParse({ truncated: true }).success).toBe(true);
    expect(GitDiffResultSchema.safeParse({ blobRef: "blob-1", truncated: false }).success).toBe(
      true,
    );
  });

  it("GitBranchInfoSchema requires name/isCurrent; checkedOutAt/upstream/lastCommitAt stay optional", () => {
    expect(GitBranchInfoSchema.safeParse({ name: "main", isCurrent: true }).success).toBe(true);
    expect(
      GitBranchInfoSchema.safeParse({
        name: "wf/foo",
        isCurrent: false,
        checkedOutAt: "/repo/.worktrees/wf/foo",
        upstream: "origin/wf/foo",
        lastCommitAt: 1_700_000_000,
      }).success,
    ).toBe(true);
    expect(GitBranchInfoSchema.safeParse({ name: "main" }).success).toBe(false);
  });

  it("GitBranchesResultSchema carries a list of GitBranchInfo", () => {
    expect(
      GitBranchesResultSchema.safeParse({
        branches: [
          { name: "main", isCurrent: true },
          { name: "wf/foo", isCurrent: false, checkedOutAt: "/repo/.worktrees/wf/foo" },
        ],
      }).success,
    ).toBe(true);
    expect(GitBranchesResultSchema.safeParse({ branches: [{ name: "main" }] }).success).toBe(false);
  });
});

describe("git.commit / git.push / git.renameBranch (write RPCs)", () => {
  it("GitCommitParamsSchema requires idempotencyKey/worktree/message; stageAll stays optional", () => {
    expect(GitCommitParamsSchema.safeParse({ worktree: "/repo", message: "fix" }).success).toBe(
      false,
    );
    expect(
      GitCommitParamsSchema.safeParse({
        idempotencyKey: "idem-9",
        worktree: "/repo",
        message: "fix",
      }).success,
    ).toBe(true);
    expect(
      GitCommitParamsSchema.safeParse({
        idempotencyKey: "idem-9",
        worktree: "/repo",
        message: "fix",
        stageAll: true,
      }).success,
    ).toBe(true);
    expect(
      GitCommitParamsSchema.safeParse({ idempotencyKey: "idem-9", worktree: "/repo" }).success,
    ).toBe(false);
  });

  it("GitCommitResultSchema requires `committed`; commitSha/nothingToCommit stay optional", () => {
    expect(GitCommitResultSchema.safeParse({}).success).toBe(false);
    expect(GitCommitResultSchema.safeParse({ committed: true }).success).toBe(true);
    expect(GitCommitResultSchema.safeParse({ committed: true, commitSha: "abc1234" }).success).toBe(
      true,
    );
    expect(
      GitCommitResultSchema.safeParse({ committed: false, nothingToCommit: true }).success,
    ).toBe(true);
  });

  it("GitPushParamsSchema requires idempotencyKey/worktree; remote/branch/force/setUpstream stay optional", () => {
    expect(GitPushParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      GitPushParamsSchema.safeParse({ idempotencyKey: "idem-10", worktree: "/repo" }).success,
    ).toBe(true);
    expect(
      GitPushParamsSchema.safeParse({
        idempotencyKey: "idem-10",
        worktree: "/repo",
        remote: "origin",
        branch: "main",
        force: true,
        setUpstream: true,
      }).success,
    ).toBe(true);
  });

  it("GitPushResultSchema requires ok:true/remote/branch/forced", () => {
    expect(
      GitPushResultSchema.safeParse({ ok: true, remote: "origin", branch: "main", forced: false })
        .success,
    ).toBe(true);
    expect(
      GitPushResultSchema.safeParse({ ok: false, remote: "origin", branch: "main" }).success,
    ).toBe(false);
    expect(
      GitPushResultSchema.safeParse({ ok: true, remote: "origin", branch: "main" }).success,
    ).toBe(false);
  });

  it("GitRenameBranchParamsSchema requires idempotencyKey/worktree/to; from stays optional", () => {
    expect(
      GitRenameBranchParamsSchema.safeParse({ worktree: "/repo", to: "renamed" }).success,
    ).toBe(false);
    expect(
      GitRenameBranchParamsSchema.safeParse({
        idempotencyKey: "idem-11",
        worktree: "/repo",
        to: "renamed",
      }).success,
    ).toBe(true);
    expect(
      GitRenameBranchParamsSchema.safeParse({
        idempotencyKey: "idem-11",
        worktree: "/repo",
        from: "old-name",
        to: "renamed",
      }).success,
    ).toBe(true);
  });

  it("GitRenameBranchResultSchema requires ok:true/branch/hadUpstream", () => {
    expect(
      GitRenameBranchResultSchema.safeParse({ ok: true, branch: "renamed", hadUpstream: true })
        .success,
    ).toBe(true);
    expect(GitRenameBranchResultSchema.safeParse({ ok: true, branch: "renamed" }).success).toBe(
      false,
    );
  });
});

describe("SpawnResultSchema", () => {
  it("accepts a plain success result", () => {
    expect(SpawnResultSchema.safeParse({ sessionId: "sess-1" }).success).toBe(true);
  });

  it("accepts a directory-creation-approval result with no sessionId", () => {
    expect(
      SpawnResultSchema.safeParse({
        requiresApproval: { action: "create-directory", directory: "/tmp/new-project" },
      }).success,
    ).toBe(true);
  });

  it("accepts a register-workspace-approval result (Flow 3 Piece A — a fresh, unregistered folder)", () => {
    expect(
      SpawnResultSchema.safeParse({
        requiresApproval: { action: "register-workspace", directory: "/tmp/fresh-folder" },
      }).success,
    ).toBe(true);
  });

  it("rejects a requiresApproval action outside the two known variants", () => {
    expect(
      SpawnResultSchema.safeParse({
        requiresApproval: { action: "delete-everything", directory: "/tmp/x" },
      }).success,
    ).toBe(false);
  });
});

describe("workspace.register schemas (Flow 3 — spawn-fresh-folder-register, Piece A)", () => {
  it("requires idempotencyKey and directory", () => {
    expect(WorkspaceRegisterParamsSchema.safeParse({}).success).toBe(false);
    expect(
      WorkspaceRegisterParamsSchema.safeParse({ directory: "/tmp/fresh-folder" }).success,
    ).toBe(false);
    expect(
      WorkspaceRegisterParamsSchema.safeParse({
        idempotencyKey: "idem-ws-1",
        directory: "/tmp/fresh-folder",
      }).success,
    ).toBe(true);
  });

  it("result is a bare {ok}", () => {
    expect(WorkspaceRegisterResultSchema.safeParse({ ok: true }).success).toBe(true);
    expect(WorkspaceRegisterResultSchema.safeParse({}).success).toBe(false);
  });
});

describe("fs.list / fs.mkdir schemas (directory picker)", () => {
  it("fs.list requires idempotencyKey; `path` is optional", () => {
    expect(FsListParamsSchema.safeParse({}).success).toBe(false);
    expect(FsListParamsSchema.safeParse({ idempotencyKey: "idem-7" }).success).toBe(true);
    expect(
      FsListParamsSchema.safeParse({ idempotencyKey: "idem-7", path: "/home/me" }).success,
    ).toBe(true);
  });

  it("fs.list result carries a resolved path, nullable parent, and directory entries", () => {
    expect(
      FsListResultSchema.safeParse({
        path: "/home/me/projects",
        parent: "/home/me",
        entries: [{ name: "falcon", isDirectory: true }],
      }).success,
    ).toBe(true);
    expect(FsListResultSchema.safeParse({ path: "/", parent: null, entries: [] }).success).toBe(
      true,
    );
  });

  it("fs.mkdir requires idempotencyKey and an absolute-ish path string", () => {
    expect(FsMkdirParamsSchema.safeParse({ path: "/tmp/new" }).success).toBe(false);
    expect(
      FsMkdirParamsSchema.safeParse({ idempotencyKey: "idem-8", path: "/tmp/new" }).success,
    ).toBe(true);
    expect(FsMkdirResultSchema.safeParse({ ok: true }).success).toBe(true);
  });
});

describe("session RPC schemas", () => {
  it("perm.answer carries a PermDecision and first-wins result shape", () => {
    expect(
      PermAnswerParamsSchema.safeParse({ reqId: "r1", decision: { kind: "deny" } }).success,
    ).toBe(true);
    expect(
      PermAnswerResultSchema.safeParse({
        ok: false,
        reason: "already-answered",
        decision: { kind: "deny" },
      }).success,
    ).toBe(true);
    expect(PermAnswerResultSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it("message RPC result accepts the legacy queued-only shape (pre-claim-store producers, design §7.10)", () => {
    expect(MessageRpcResultSchema.safeParse({ queued: true }).success).toBe(true);
    expect(MessageRpcResultSchema.safeParse({ queued: false }).success).toBe(true);
  });

  it("message RPC result accepts the tri-state `status` field additively", () => {
    for (const status of ["queued", "duplicate", "outcome-unknown"] as const) {
      expect(MessageRpcResultSchema.safeParse({ queued: true, status }).success).toBe(true);
    }
  });

  it("message RPC result rejects an unrecognized status value", () => {
    expect(MessageRpcResultSchema.safeParse({ queued: true, status: "sent" }).success).toBe(false);
  });

  it("message RPC result still requires `queued` (unchanged, additive-only)", () => {
    expect(MessageRpcResultSchema.safeParse({ status: "queued" }).success).toBe(false);
  });
});

describe("SetModeResultSchema (W4.3 — additive `observedMode` for the PTY verify-via-hook-echo path)", () => {
  it("accepts the pre-W4.3 shape with `ok` alone (unchanged, additive-only)", () => {
    expect(SetModeResultSchema.safeParse({ ok: false }).success).toBe(true);
    expect(SetModeResultSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it("accepts an `observedMode` for any valid permission mode", () => {
    for (const observedMode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
      expect(SetModeResultSchema.safeParse({ ok: true, observedMode }).success).toBe(true);
      expect(SetModeResultSchema.safeParse({ ok: false, observedMode }).success).toBe(true);
    }
  });

  it("rejects an unrecognized `observedMode` value", () => {
    expect(
      SetModeResultSchema.safeParse({ ok: false, observedMode: "some-future-mode" }).success,
    ).toBe(false);
  });

  it("still requires `ok` (unchanged, additive-only)", () => {
    expect(SetModeResultSchema.safeParse({ observedMode: "plan" }).success).toBe(false);
  });
});
