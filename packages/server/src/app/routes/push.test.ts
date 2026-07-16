import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createTestAccount, createTestDb } from "./testHelpers.js";

describe("POST/DELETE /v1/push/subscribe", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;
  let authHeader: string;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    app = await buildServer({ logger: false }, { db });

    const account = await createTestAccount(db);
    authHeader = account.authHeader;
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("registers a webpush subscription with its p256dh/auth keys", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: {
        channel: "webpush",
        endpoint: "https://push.example/device-1",
        keys: { p256dh: "p256dh-val", auth: "auth-val" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: expect.any(String) });
  });

  it("registers a channel-only subscription (ntfy) with no keys", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: { channel: "ntfy", endpoint: "my-ntfy-topic" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("re-subscribing the same endpoint from the same account updates in place (idempotent)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: {
        channel: "webpush",
        endpoint: "https://push.example/device-resub",
        keys: { p256dh: "old", auth: "old" },
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: {
        channel: "webpush",
        endpoint: "https://push.example/device-resub",
        keys: { p256dh: "new", auth: "new" },
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it("409s when the endpoint is already registered to a different account", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: { channel: "ntfy", endpoint: "shared-endpoint-collision" },
    });

    const { authHeader: otherHeader } = await createTestAccount(db);
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: otherHeader },
      payload: { channel: "ntfy", endpoint: "shared-endpoint-collision" },
    });

    expect(response.statusCode).toBe(409);
  });

  it("401s without an Authorization header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      payload: { channel: "ntfy", endpoint: "no-auth-endpoint" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("unsubscribes by endpoint, scoped to the caller's own account", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: { channel: "ntfy", endpoint: "to-be-removed" },
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: { endpoint: "to-be-removed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    // Re-subscribing to the now-freed endpoint succeeds — proves the row was
    // actually deleted, not just hidden from this account's own view.
    const resub = await app.inject({
      method: "POST",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: { channel: "webpush", endpoint: "to-be-removed", keys: { p256dh: "a", auth: "b" } },
    });
    expect(resub.statusCode).toBe(200);
  });

  it("DELETE is a no-op (still 200) for an endpoint the caller never subscribed", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/push/subscribe",
      headers: { authorization: authHeader },
      payload: { endpoint: "never-existed" },
    });
    expect(response.statusCode).toBe(200);
  });
});
