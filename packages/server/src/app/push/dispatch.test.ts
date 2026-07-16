import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, pushSubscriptions, sessions } from "../../db/schema.js";
import { createTestDb } from "../routes/testHelpers.js";
import { channels } from "./channels/index.js";
import { buildPushDispatcher } from "./dispatch.js";
import type { PresencePort } from "./types.js";

function fakePresence(active: boolean): PresencePort {
  return { hasActiveVisibleClient: vi.fn().mockResolvedValue(active) };
}

async function seedAccountAndSubscription(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  overrides: Partial<typeof pushSubscriptions.$inferInsert> = {},
) {
  const [account] = await db
    .insert(accounts)
    .values({ signPublicKey: `pk-${Math.random()}`, contentPubKey: "cpk" })
    .returning();
  if (!account) throw new Error("seed: account insert returned no row");

  const [sub] = await db
    .insert(pushSubscriptions)
    .values({
      accountId: account.id,
      channel: "webpush",
      endpoint: `https://push.example/${Math.random()}`,
      keys: { p256dh: "p256dh-val", auth: "auth-val" },
      ...overrides,
    })
    .returning();
  if (!sub) throw new Error("seed: subscription insert returned no row");

  return { account, sub };
}

describe("buildPushDispatcher", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeEach(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
  });

  afterEach(async () => {
    await pglite.close();
    vi.restoreAllMocks();
  });

  it("suppresses the push when the presence check reports an active visible client", async () => {
    const { account } = await seedAccountAndSubscription(db);
    const sendSpy = vi.spyOn(channels.webpush, "send");

    const dispatcher = buildPushDispatcher(db, fakePresence(true));
    await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_1", kind: "done" });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sends to every subscription for the account when no visible client is present", async () => {
    const { account } = await seedAccountAndSubscription(db);
    const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_1", kind: "perm" });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ accountId: account.id }), {
      sessionId: "sess_1",
      kind: "perm",
    });
  });

  it("dispatches to every account channel present, not just webpush", async () => {
    const { account } = await seedAccountAndSubscription(db);
    await seedAccountAndSubscription(db, { channel: "ntfy" }); // different account, ignored
    const [ntfySub] = await db
      .insert(pushSubscriptions)
      .values({ accountId: account.id, channel: "ntfy", endpoint: "ntfy-topic-1" })
      .returning();
    if (!ntfySub) throw new Error("seed: ntfy insert returned no row");

    const webpushSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);
    const ntfySpy = vi.spyOn(channels.ntfy, "send").mockResolvedValue(undefined);

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_2", kind: "question" });

    expect(webpushSpy).toHaveBeenCalledTimes(1);
    expect(ntfySpy).toHaveBeenCalledTimes(1);
  });

  it("dispatches anyway when the presence check itself throws (fail open)", async () => {
    const { account } = await seedAccountAndSubscription(db);
    const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);
    const brokenPresence: PresencePort = {
      hasActiveVisibleClient: vi.fn().mockRejectedValue(new Error("presence backend down")),
    };

    const dispatcher = buildPushDispatcher(db, brokenPresence);
    await expect(
      dispatcher.dispatch({ accountId: account.id, sessionId: "sess_3", kind: "failed" }),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("prunes a subscription whose channel reports it's gone (404/410) without throwing", async () => {
    const { account, sub } = await seedAccountAndSubscription(db);
    vi.spyOn(channels.webpush, "send").mockRejectedValue(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_4", kind: "done" });

    const remaining = await db.query.pushSubscriptions.findFirst({
      where: (row, { eq }) => eq(row.id, sub.id),
    });
    expect(remaining).toBeUndefined();
  });

  it("never rejects when a channel send throws a non-gone error, and doesn't prune the subscription", async () => {
    const { account, sub } = await seedAccountAndSubscription(db);
    vi.spyOn(channels.webpush, "send").mockRejectedValue(new Error("network blip"));

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await expect(
      dispatcher.dispatch({ accountId: account.id, sessionId: "sess_5", kind: "done" }),
    ).resolves.toBeUndefined();

    const remaining = await db.query.pushSubscriptions.findFirst({
      where: (row, { eq }) => eq(row.id, sub.id),
    });
    expect(remaining).toBeDefined();
  });

  it("suppresses the push when the account has notificationsMutedAll set", async () => {
    const { account } = await seedAccountAndSubscription(db);
    await db
      .update(accounts)
      .set({ notificationsMutedAll: true })
      .where(eq(accounts.id, account.id));
    const sendSpy = vi.spyOn(channels.webpush, "send");

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_muted_all", kind: "perm" });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("suppresses the push when the specific session is muted", async () => {
    const { account } = await seedAccountAndSubscription(db);
    const [session] = await db
      .insert(sessions)
      .values({
        accountId: account.id,
        tag: "muted-session",
        provider: "claude-code",
        metadata: new Uint8Array(),
        dek: new Uint8Array(),
        notificationsMuted: true,
      })
      .returning();
    if (!session) throw new Error("seed: session insert returned no row");
    const sendSpy = vi.spyOn(channels.webpush, "send");

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await dispatcher.dispatch({ accountId: account.id, sessionId: session.id, kind: "perm" });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not suppress an unmuted session belonging to a non-muted account", async () => {
    const { account } = await seedAccountAndSubscription(db);
    const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);

    const dispatcher = buildPushDispatcher(db, fakePresence(false));
    await dispatcher.dispatch({
      accountId: account.id,
      sessionId: "sess_not_muted",
      kind: "perm",
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("is a silent no-op when the account has no subscriptions", async () => {
    const sendSpy = vi.spyOn(channels.webpush, "send");
    const dispatcher = buildPushDispatcher(db, fakePresence(false));

    await expect(
      dispatcher.dispatch({ accountId: "acct-with-no-subs", sessionId: "sess_6", kind: "done" }),
    ).resolves.toBeUndefined();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  describe("re-notify scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-notifies an unanswered perm dispatch at +5min and +10min, capped at 3 total", async () => {
      const { account } = await seedAccountAndSubscription(db);
      const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);

      const dispatcher = buildPushDispatcher(db, fakePresence(false));
      await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_perm", kind: "perm" });
      expect(sendSpy).toHaveBeenCalledTimes(1); // the initial notification

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendSpy).toHaveBeenCalledTimes(3);

      // No further follow-ups beyond the +10min mark — max 3 total.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(sendSpy).toHaveBeenCalledTimes(3);
    });

    it("does not schedule follow-ups for terminal kinds like done/failed", async () => {
      const { account } = await seedAccountAndSubscription(db);
      const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);

      const dispatcher = buildPushDispatcher(db, fakePresence(false));
      await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_done", kind: "done" });
      expect(sendSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(sendSpy).toHaveBeenCalledTimes(1); // no follow-up ever fires
    });

    it("suppresses a follow-up the same way the initial dispatch is suppressed", async () => {
      const { account } = await seedAccountAndSubscription(db);
      const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);
      const presenceCheck = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const dispatcher = buildPushDispatcher(db, { hasActiveVisibleClient: presenceCheck });
      await dispatcher.dispatch({
        accountId: account.id,
        sessionId: "sess_suppressed",
        kind: "perm",
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // A visible client shows up before the +5min follow-up fires.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendSpy).toHaveBeenCalledTimes(1); // still 1 — the follow-up was suppressed
    });

    it("cancels a still-pending schedule when a later event for the same session lands", async () => {
      const { account } = await seedAccountAndSubscription(db);
      const sendSpy = vi.spyOn(channels.webpush, "send").mockResolvedValue(undefined);

      const dispatcher = buildPushDispatcher(db, fakePresence(false));
      await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_race", kind: "perm" });
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Turn completes before the +5min follow-up would have fired.
      await dispatcher.dispatch({ accountId: account.id, sessionId: "sess_race", kind: "done" });
      expect(sendSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(sendSpy).toHaveBeenCalledTimes(2); // no stale perm follow-up ever fires
    });
  });
});
