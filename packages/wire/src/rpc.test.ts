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
  GitInitParamsSchema,
  GitInitResultSchema,
  GitPushParamsSchema,
  GitPushResultSchema,
  GitRenameBranchParamsSchema,
  GitRenameBranchResultSchema,
  GitSetRemoteParamsSchema,
  GitSetRemoteResultSchema,
  GitStatusParamsSchema,
  GitStatusResultSchema,
  MessageRpcResultSchema,
  PermAnswerParamsSchema,
  PermAnswerResultSchema,
  RpcCallSchema,
  RUNNING_SESSION_MODEL_ALIASES,
  RunSetupParamsSchema,
  RunSetupResultSchema,
  RunStartParamsSchema,
  RunStartResultSchema,
  RunStatusParamsSchema,
  RunStatusResultSchema,
  RunStopParamsSchema,
  RunStopResultSchema,
  SetModelParamsSchema,
  SetModelResultSchema,
  SetModeResultSchema,
  SlashCommandInfoSchema,
  SlashCommandsListParamsSchema,
  SlashCommandsListResultSchema,
  SleepInhibitGetParamsSchema,
  SleepInhibitModeSchema,
  SleepInhibitSetParamsSchema,
  SleepInhibitStateSchema,
  SpawnParamsSchema,
  SpawnResultSchema,
  WorkspaceGetConfigParamsSchema,
  WorkspaceGetConfigResultSchema,
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

describe("SpawnParamsSchema.branch.from (docs/competitive-notes-omnara.md #16 searchable base-branch picker)", () => {
  const base = {
    idempotencyKey: "idem-1",
    workspaceId: "w1",
    directory: "/tmp",
    provider: "claude-code" as const,
    permissionMode: "default" as const,
  };

  it("accepts a branch option with a `from` base ref", () => {
    expect(
      SpawnParamsSchema.safeParse({
        ...base,
        branch: { name: "task-1", createWorktree: true, from: "main" },
      }).success,
    ).toBe(true);
  });

  it("still accepts a branch option with no `from` (additive, backward-compatible)", () => {
    expect(
      SpawnParamsSchema.safeParse({
        ...base,
        branch: { name: "task-1", createWorktree: true },
      }).success,
    ).toBe(true);
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

    expect(SlashCommandsListParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      SlashCommandsListParamsSchema.safeParse({ idempotencyKey: "idem-9", worktree: "/repo" })
        .success,
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

    expect(GitInitParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      GitInitParamsSchema.safeParse({ idempotencyKey: "idem-12", worktree: "/repo" }).success,
    ).toBe(true);

    expect(
      GitSetRemoteParamsSchema.safeParse({ worktree: "/repo", url: "git@github.com:a/b.git" })
        .success,
    ).toBe(false);
    expect(
      GitSetRemoteParamsSchema.safeParse({
        idempotencyKey: "idem-13",
        worktree: "/repo",
        url: "git@github.com:a/b.git",
      }).success,
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

describe("commands.list result shapes", () => {
  it("SlashCommandInfoSchema requires name; description/argumentHint stay optional", () => {
    expect(SlashCommandInfoSchema.safeParse({ name: "compact" }).success).toBe(true);
    expect(
      SlashCommandInfoSchema.safeParse({
        name: "git:commit",
        description: "Create a commit",
        argumentHint: "[message]",
      }).success,
    ).toBe(true);
    expect(SlashCommandInfoSchema.safeParse({ description: "no name" }).success).toBe(false);
  });

  it("SlashCommandsListResultSchema carries a list of SlashCommandInfo", () => {
    expect(
      SlashCommandsListResultSchema.safeParse({
        commands: [{ name: "compact" }, { name: "git:commit", description: "Create a commit" }],
      }).success,
    ).toBe(true);
    expect(SlashCommandsListResultSchema.safeParse({ commands: [{}] }).success).toBe(false);
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

describe("git.init / git.setRemote (Feature 1, docs/web-ux-improvements-plan.md)", () => {
  it("GitInitParamsSchema requires idempotencyKey/worktree; initialBranch stays optional", () => {
    expect(GitInitParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      GitInitParamsSchema.safeParse({ idempotencyKey: "idem-12", worktree: "/repo" }).success,
    ).toBe(true);
    expect(
      GitInitParamsSchema.safeParse({
        idempotencyKey: "idem-12",
        worktree: "/repo",
        initialBranch: "trunk",
      }).success,
    ).toBe(true);
  });

  it("GitInitResultSchema requires `state` from its fixed enum; branch/existingRoot stay optional", () => {
    expect(GitInitResultSchema.safeParse({ state: "initialized", branch: "main" }).success).toBe(
      true,
    );
    expect(GitInitResultSchema.safeParse({ state: "already-repo" }).success).toBe(true);
    expect(
      GitInitResultSchema.safeParse({ state: "inside-existing-repo", existingRoot: "/repo" })
        .success,
    ).toBe(true);
    expect(GitInitResultSchema.safeParse({ state: "bogus" }).success).toBe(false);
    expect(GitInitResultSchema.safeParse({}).success).toBe(false);
  });

  it("GitSetRemoteParamsSchema requires idempotencyKey/worktree/url; name stays optional", () => {
    expect(
      GitSetRemoteParamsSchema.safeParse({ worktree: "/repo", url: "https://example.com/a.git" })
        .success,
    ).toBe(false);
    expect(
      GitSetRemoteParamsSchema.safeParse({
        idempotencyKey: "idem-13",
        worktree: "/repo",
        url: "https://example.com/a.git",
      }).success,
    ).toBe(true);
    expect(
      GitSetRemoteParamsSchema.safeParse({
        idempotencyKey: "idem-13",
        worktree: "/repo",
        name: "upstream",
        url: "https://example.com/a.git",
      }).success,
    ).toBe(true);
  });

  it("GitSetRemoteResultSchema requires ok:true/name/url/created", () => {
    expect(
      GitSetRemoteResultSchema.safeParse({
        ok: true,
        name: "origin",
        url: "https://example.com/a.git",
        created: true,
      }).success,
    ).toBe(true);
    expect(
      GitSetRemoteResultSchema.safeParse({ ok: false, name: "origin", url: "x", created: true })
        .success,
    ).toBe(false);
    expect(GitSetRemoteResultSchema.safeParse({ ok: true, name: "origin", url: "x" }).success).toBe(
      false,
    );
  });
});

describe("sleepInhibit.get / sleepInhibit.set schemas (docs/competitive-notes-omnara.md #12)", () => {
  it("SleepInhibitModeSchema accepts the tri-state values and rejects anything else", () => {
    expect(SleepInhibitModeSchema.safeParse("off").success).toBe(true);
    expect(SleepInhibitModeSchema.safeParse("onPower").success).toBe(true);
    expect(SleepInhibitModeSchema.safeParse("always").success).toBe(true);
    expect(SleepInhibitModeSchema.safeParse("forever").success).toBe(false);
  });

  it("SleepInhibitGetParamsSchema requires idempotencyKey", () => {
    expect(SleepInhibitGetParamsSchema.safeParse({}).success).toBe(false);
    expect(SleepInhibitGetParamsSchema.safeParse({ idempotencyKey: "idem-20" }).success).toBe(true);
  });

  it("SleepInhibitSetParamsSchema requires idempotencyKey and a valid mode", () => {
    expect(SleepInhibitSetParamsSchema.safeParse({ idempotencyKey: "k" }).success).toBe(false);
    expect(
      SleepInhibitSetParamsSchema.safeParse({ idempotencyKey: "k", mode: "onPower" }).success,
    ).toBe(true);
    expect(
      SleepInhibitSetParamsSchema.safeParse({ idempotencyKey: "k", mode: "forever" }).success,
    ).toBe(false);
  });

  it("SleepInhibitStateSchema round-trips supported/platform/mode/active", () => {
    expect(
      SleepInhibitStateSchema.safeParse({
        supported: true,
        platform: "darwin",
        mode: "always",
        active: true,
      }).success,
    ).toBe(true);
    expect(
      SleepInhibitStateSchema.safeParse({
        supported: false,
        platform: "linux",
        mode: "off",
        active: false,
      }).success,
    ).toBe(true);
    expect(
      SleepInhibitStateSchema.safeParse({ supported: true, platform: "darwin", mode: "always" })
        .success,
    ).toBe(false);
  });
});

describe("workspace.getConfig / run.* schemas (docs/features/setup-run-scripts.md)", () => {
  it("WorkspaceGetConfigParamsSchema requires idempotencyKey/worktree", () => {
    expect(WorkspaceGetConfigParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      WorkspaceGetConfigParamsSchema.safeParse({ idempotencyKey: "idem-20", worktree: "/repo" })
        .success,
    ).toBe(true);
  });

  it("WorkspaceGetConfigResultSchema is empty-object-valid; every field is optional", () => {
    expect(WorkspaceGetConfigResultSchema.safeParse({}).success).toBe(true);
    expect(
      WorkspaceGetConfigResultSchema.safeParse({
        baseRef: "main",
        remote: "origin",
        setupScript: "npm install",
        runScript: "npm run dev",
      }).success,
    ).toBe(true);
  });

  it("RunStartParamsSchema requires idempotencyKey/worktree", () => {
    expect(RunStartParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      RunStartParamsSchema.safeParse({ idempotencyKey: "idem-21", worktree: "/repo" }).success,
    ).toBe(true);
  });

  it("RunStartResultSchema requires `started`; method is constrained to tmux/detached", () => {
    expect(RunStartResultSchema.safeParse({}).success).toBe(false);
    expect(RunStartResultSchema.safeParse({ started: true }).success).toBe(true);
    expect(
      RunStartResultSchema.safeParse({
        started: true,
        method: "tmux",
        pid: 123,
        tmuxSessionName: "falcon-run-abc",
      }).success,
    ).toBe(true);
    expect(RunStartResultSchema.safeParse({ started: true, method: "ssh" }).success).toBe(false);
  });

  it("RunStopParamsSchema/RunStopResultSchema", () => {
    expect(
      RunStopParamsSchema.safeParse({ idempotencyKey: "idem-22", worktree: "/repo" }).success,
    ).toBe(true);
    expect(RunStopResultSchema.safeParse({ stopped: true, wasRunning: true }).success).toBe(true);
    expect(RunStopResultSchema.safeParse({ stopped: true }).success).toBe(false);
  });

  it("RunStatusParamsSchema requires idempotencyKey/worktree", () => {
    expect(RunStatusParamsSchema.safeParse({ worktree: "/repo" }).success).toBe(false);
    expect(
      RunStatusParamsSchema.safeParse({ idempotencyKey: "idem-24", worktree: "/repo" }).success,
    ).toBe(true);
  });

  it("RunStatusResultSchema requires nested run/setup state enums", () => {
    expect(
      RunStatusResultSchema.safeParse({
        run: { state: "running", pid: 1, method: "tmux", startedAt: 1, logTail: "hi" },
        setup: { state: "succeeded", exitCode: 0, startedAt: 1, finishedAt: 2, logTail: "ok" },
      }).success,
    ).toBe(true);
    expect(
      RunStatusResultSchema.safeParse({
        run: { state: "none" },
        setup: { state: "not-run" },
      }).success,
    ).toBe(true);
    expect(
      RunStatusResultSchema.safeParse({
        run: { state: "bogus" },
        setup: { state: "not-run" },
      }).success,
    ).toBe(false);
  });

  it("RunSetupParamsSchema/RunSetupResultSchema", () => {
    expect(
      RunSetupParamsSchema.safeParse({ idempotencyKey: "idem-23", worktree: "/repo" }).success,
    ).toBe(true);
    expect(RunSetupResultSchema.safeParse({ started: true }).success).toBe(true);
    expect(RunSetupResultSchema.safeParse({ started: true, alreadyRunning: true }).success).toBe(
      true,
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

describe("SetModelParamsSchema (issue #12 — web model selector)", () => {
  it("accepts every curated running-session model alias", () => {
    for (const model of RUNNING_SESSION_MODEL_ALIASES) {
      expect(SetModelParamsSchema.safeParse({ model }).success).toBe(true);
    }
  });

  it("rejects a non-curated model string — the enum is a keystroke-injection allowlist, not free text", () => {
    expect(SetModelParamsSchema.safeParse({ model: "claude-sonnet-4-5-20250929" }).success).toBe(
      false,
    );
  });

  it("rejects an embedded control character even if it happens to prefix a valid alias", () => {
    expect(SetModelParamsSchema.safeParse({ model: "sonnet\r/bash rm -rf ~" }).success).toBe(false);
  });

  it("requires `model`", () => {
    expect(SetModelParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe("SetModelResultSchema (issue #12 — free-text observedModel echo)", () => {
  it("accepts the minimal shape with `ok` alone", () => {
    expect(SetModelResultSchema.safeParse({ ok: false }).success).toBe(true);
    expect(SetModelResultSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it("accepts any non-empty observedModel string — Claude Code's own free-text display name", () => {
    expect(SetModelResultSchema.safeParse({ ok: true, observedModel: "Sonnet 5" }).success).toBe(
      true,
    );
  });

  it("still requires `ok`", () => {
    expect(SetModelResultSchema.safeParse({ observedModel: "Sonnet 5" }).success).toBe(false);
  });
});
