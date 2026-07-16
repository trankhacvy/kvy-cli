import { describe, expect, it } from "vitest";
import {
  AdoptListParamsSchema,
  AdoptMirrorParamsSchema,
  AdoptMirrorResultSchema,
  AdoptTakeParamsSchema,
  AdoptTakeResultSchema,
  FsReadParamsSchema,
  GitDiffParamsSchema,
  GitStatusParamsSchema,
  PermAnswerParamsSchema,
  PermAnswerResultSchema,
  RpcCallSchema,
  SpawnParamsSchema,
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
