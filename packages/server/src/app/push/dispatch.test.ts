import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accounts, pushSubscriptions } from "../../db/schema.js";
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

  it("is a silent no-op when the account has no subscriptions", async () => {
    const sendSpy = vi.spyOn(channels.webpush, "send");
    const dispatcher = buildPushDispatcher(db, fakePresence(false));

    await expect(
      dispatcher.dispatch({ accountId: "acct-with-no-subs", sessionId: "sess_6", kind: "done" }),
    ).resolves.toBeUndefined();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
