import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimMessageSend,
  claimsFilePath,
  clearClaims,
  completeMessageSend,
  readClaims,
} from "./claimStore.js";

describe("claimStore", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "falcon-claim-store-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("returns {} when no claim file exists yet", async () => {
    expect(await readClaims("sess_1", { homeDir })).toEqual({});
  });

  it("fresh claim: a new envelope id is claimed and durably recorded", async () => {
    const outcome = await claimMessageSend("sess_1", "env_1", { homeDir });
    expect(outcome.status).toBe("claimed");
    if (outcome.status !== "claimed") throw new Error("unreachable");
    expect(outcome.claimId).toMatch(/^[0-9a-f-]{36}$/);

    const claims = await readClaims("sess_1", { homeDir });
    expect(claims.env_1).toEqual({
      status: "claimed",
      claimId: outcome.claimId,
      claimedAt: expect.any(Number),
    });
  });

  it("duplicate claim: re-claiming an envelope id whose send already completed replays the result", async () => {
    const first = await claimMessageSend("sess_1", "env_1", { homeDir });
    if (first.status !== "claimed") throw new Error("unreachable");
    await completeMessageSend(
      "sess_1",
      "env_1",
      first.claimId,
      { stopReason: "end_turn" },
      { homeDir },
    );

    const second = await claimMessageSend("sess_1", "env_1", { homeDir });
    expect(second).toEqual({ status: "completed", result: { stopReason: "end_turn" } });
  });

  it("claim with no completion is indeterminate: a second claim attempt must not proceed", async () => {
    const first = await claimMessageSend("sess_1", "env_1", { homeDir });
    expect(first.status).toBe("claimed");

    // No completeMessageSend call — simulates a crash mid-turn.
    const second = await claimMessageSend("sess_1", "env_1", { homeDir });
    expect(second).toEqual({ status: "in-progress" });

    // The original claim is still exactly what it was — nothing silently re-executed or overwritten.
    const claims = await readClaims("sess_1", { homeDir });
    expect(claims.env_1).toMatchObject({ status: "claimed" });
  });

  it("concurrent claims for the same envelope id: exactly one wins, the other sees in-progress", async () => {
    const [a, b] = await Promise.all([
      claimMessageSend("sess_1", "env_1", { homeDir }),
      claimMessageSend("sess_1", "env_1", { homeDir }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["claimed", "in-progress"]);
  });

  it("claims for different envelope ids in the same session don't collide", async () => {
    const a = await claimMessageSend("sess_1", "env_1", { homeDir });
    const b = await claimMessageSend("sess_1", "env_2", { homeDir });
    expect(a.status).toBe("claimed");
    expect(b.status).toBe("claimed");

    const claims = await readClaims("sess_1", { homeDir });
    expect(Object.keys(claims).sort()).toEqual(["env_1", "env_2"]);
  });

  it("claims are scoped per session — same envelope id in a different session doesn't collide", async () => {
    const a = await claimMessageSend("sess_1", "env_1", { homeDir });
    const b = await claimMessageSend("sess_2", "env_1", { homeDir });
    expect(a.status).toBe("claimed");
    expect(b.status).toBe("claimed");
  });

  it("completeMessageSend throws when there is no active claim for the envelope id", async () => {
    await expect(
      completeMessageSend("sess_1", "env_1", "not-a-real-claim-id", { ok: true }, { homeDir }),
    ).rejects.toThrow(/no active claim/);
  });

  it("completeMessageSend throws when claimId doesn't match the active claim", async () => {
    const first = await claimMessageSend("sess_1", "env_1", { homeDir });
    expect(first.status).toBe("claimed");

    await expect(
      completeMessageSend("sess_1", "env_1", "wrong-claim-id", { ok: true }, { homeDir }),
    ).rejects.toThrow(/no active claim/);

    // The mismatched attempt must not have clobbered the still-pending claim.
    const claims = await readClaims("sess_1", { homeDir });
    expect(claims.env_1).toMatchObject({ status: "claimed" });
  });

  it("completeMessageSend is rejected a second time once a claim is already completed", async () => {
    const first = await claimMessageSend("sess_1", "env_1", { homeDir });
    if (first.status !== "claimed") throw new Error("unreachable");
    await completeMessageSend("sess_1", "env_1", first.claimId, { done: true }, { homeDir });

    await expect(
      completeMessageSend("sess_1", "env_1", first.claimId, { done: true }, { homeDir }),
    ).rejects.toThrow(/no active claim/);
  });

  it("a result of undefined still round-trips as a completed entry, not a dropped one", async () => {
    const first = await claimMessageSend("sess_1", "env_1", { homeDir });
    if (first.status !== "claimed") throw new Error("unreachable");
    await completeMessageSend("sess_1", "env_1", first.claimId, undefined, { homeDir });

    const second = await claimMessageSend("sess_1", "env_1", { homeDir });
    expect(second).toEqual({ status: "completed", result: null });
  });

  it("treats a corrupt claim file as empty", async () => {
    await mkdir(path.dirname(claimsFilePath(homeDir, "sess_1")), { recursive: true });
    await writeFile(claimsFilePath(homeDir, "sess_1"), "{not valid json", "utf8");
    expect(await readClaims("sess_1", { homeDir })).toEqual({});
  });

  it("drops a well-formed-JSON-but-wrong-shape entry while keeping valid siblings", async () => {
    await mkdir(path.dirname(claimsFilePath(homeDir, "sess_1")), { recursive: true });
    await writeFile(
      claimsFilePath(homeDir, "sess_1"),
      JSON.stringify({
        schemaVersion: 1,
        claims: {
          env_bad: { status: "claimed" }, // missing claimId/claimedAt
          env_good: { status: "claimed", claimId: "c1", claimedAt: 1 },
        },
      }),
      "utf8",
    );

    expect(await readClaims("sess_1", { homeDir })).toEqual({
      env_good: { status: "claimed", claimId: "c1", claimedAt: 1 },
    });
  });

  describe("retention/pruning", () => {
    it("prunes a completed entry once it is older than the retention window", async () => {
      const base = 1_000_000_000_000;
      const stale = base - 8 * 24 * 60 * 60 * 1000; // >7 days before base
      let now = stale;

      const first = await claimMessageSend("sess_1", "env_old", { homeDir, now: () => now });
      if (first.status !== "claimed") throw new Error("unreachable");
      await completeMessageSend(
        "sess_1",
        "env_old",
        first.claimId,
        { ok: true },
        { homeDir, now: () => now },
      );

      // Advance the clock past the retention window and perform another
      // write against the same session file — pruning happens opportunistically
      // on the next write, mirroring `sessionsStore.ts`'s own lazy-expiry convention.
      now = base;
      await claimMessageSend("sess_1", "env_new", { homeDir, now: () => now });

      const claims = await readClaims("sess_1", { homeDir, now: () => now });
      expect(Object.keys(claims)).toEqual(["env_new"]);
    });

    it("never prunes a pending (uncompleted) claim, no matter how old", async () => {
      const base = 1_000_000_000_000;
      const veryStale = base - 30 * 24 * 60 * 60 * 1000;

      await claimMessageSend("sess_1", "env_stuck", { homeDir, now: () => veryStale });
      // Trigger another write far in the future — this must NOT silently
      // drop the still-pending claim, or a later retry of env_stuck would
      // look "fresh" and re-execute.
      await claimMessageSend("sess_1", "env_new", { homeDir, now: () => base });

      const claims = await readClaims("sess_1", { homeDir, now: () => base });
      expect(Object.keys(claims).sort()).toEqual(["env_new", "env_stuck"]);
      expect(claims.env_stuck).toMatchObject({ status: "claimed" });
    });

    it("keeps a completed entry that is still within the retention window", async () => {
      const base = 1_000_000_000_000;
      const recent = base - 1 * 24 * 60 * 60 * 1000; // 1 day before base, well inside 7-day window

      const first = await claimMessageSend("sess_1", "env_recent", { homeDir, now: () => recent });
      if (first.status !== "claimed") throw new Error("unreachable");
      await completeMessageSend(
        "sess_1",
        "env_recent",
        first.claimId,
        { ok: true },
        { homeDir, now: () => recent },
      );

      await claimMessageSend("sess_1", "env_new", { homeDir, now: () => base });

      const claims = await readClaims("sess_1", { homeDir, now: () => base });
      expect(Object.keys(claims).sort()).toEqual(["env_new", "env_recent"]);
    });
  });

  it("clearClaims deletes the whole file and is safe to call twice", async () => {
    await claimMessageSend("sess_1", "env_1", { homeDir });
    await clearClaims("sess_1", { homeDir });
    expect(await readClaims("sess_1", { homeDir })).toEqual({});
    await expect(clearClaims("sess_1", { homeDir })).resolves.toBeUndefined();
    await expect(readFile(claimsFilePath(homeDir, "sess_1"), "utf8")).rejects.toThrow();
  });
});
