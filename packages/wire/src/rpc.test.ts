import { describe, expect, it } from "vitest";
import {
  AdoptListParamsSchema,
  AdoptTakeParamsSchema,
  FsListParamsSchema,
  FsListResultSchema,
  FsMkdirParamsSchema,
  FsMkdirResultSchema,
  FsReadParamsSchema,
  GitDiffParamsSchema,
  GitStatusParamsSchema,
  PermAnswerParamsSchema,
  PermAnswerResultSchema,
  RpcCallSchema,
  SpawnParamsSchema,
  SpawnResultSchema,
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

    expect(FsReadParamsSchema.safeParse({ worktree: "/repo", path: "a.ts" }).success).toBe(false);
    expect(
      FsReadParamsSchema.safeParse({ idempotencyKey: "idem-6", worktree: "/repo", path: "a.ts" })
        .success,
    ).toBe(true);
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
});
