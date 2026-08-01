import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueSession as issueSessionRaw } from "../../auth/index.js";
import * as schema from "../../db/schema.js";
import { accounts } from "../../db/schema.js";
import { buildServer } from "../server.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

/**
 * Device-to-device key sharing (docs/auth-ux-overhaul-plan.md Phase 4).
 *
 * The authorization tests here are the point: `accountId` scoping alone is NOT sufficient
 * (an attacker with a stolen access token satisfies it), so the routes additionally bind
 * the claim to the requesting session and refuse self-approval.
 */
describe("key-request routes (Phase 4)", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;

  function freshEphPub(): string {
    return encodeBase64(getRandomBytes(32));
  }

  async function issueSession(params: Parameters<typeof issueSessionRaw>[1]) {
    await db.insert(accounts).values({ id: params.accountId }).onConflictDoNothing();
    return issueSessionRaw(db, params);
  }

  function post(url: string, token: string, body: Record<string, string>) {
    return app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  beforeAll(async () => {
    pglite = new PGlite();
    db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });
    app = await buildServer({ logger: false }, { db });
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("round-trips a request through approve and claim", async () => {
    const accountId = "acct_kr_happy";
    const requester = await issueSession({ accountId, clientKind: "web" });
    const holder = await issueSession({ accountId, clientKind: "cli-daemon" });
    const ephPub = freshEphPub();

    expect(
      (await post("/v1/keys/request", requester.accessToken, { ephPub, label: "Chrome on Mac" }))
        .statusCode,
    ).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/keys/requests",
      headers: { authorization: `Bearer ${holder.accessToken}` },
    });
    const body = listed.json() as {
      requests: Array<{ ephPub: string; label: string; requesterClientKind: string }>;
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.label).toBe("Chrome on Mac");
    // Server-attested, not taken from the requester's own claim about itself.
    expect(body.requests[0]?.requesterClientKind).toBe("web");

    expect(
      (await post("/v1/keys/request/approve", holder.accessToken, { ephPub, response: "c2VhbGVk" }))
        .statusCode,
    ).toBe(200);

    const claimed = await post("/v1/keys/request/claim", requester.accessToken, { ephPub });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({ state: "ready", response: "c2VhbGVk" });
  });

  it("is single-use — a second claim finds nothing", async () => {
    const accountId = "acct_kr_singleuse";
    const requester = await issueSession({ accountId, clientKind: "web" });
    const holder = await issueSession({ accountId, clientKind: "cli-daemon" });
    const ephPub = freshEphPub();

    await post("/v1/keys/request", requester.accessToken, { ephPub });
    await post("/v1/keys/request/approve", holder.accessToken, { ephPub, response: "c2VhbGVk" });
    await post("/v1/keys/request/claim", requester.accessToken, { ephPub });

    const second = await post("/v1/keys/request/claim", requester.accessToken, { ephPub });
    expect(second.json()).toEqual({ state: "expired" });
  });

  it("reports pending until a holder approves", async () => {
    const accountId = "acct_kr_pending";
    const requester = await issueSession({ accountId, clientKind: "web" });
    const ephPub = freshEphPub();

    await post("/v1/keys/request", requester.accessToken, { ephPub });
    const claimed = await post("/v1/keys/request/claim", requester.accessToken, { ephPub });
    expect(claimed.json()).toEqual({ state: "pending" });
  });

  it("refuses an approval from ANOTHER account", async () => {
    const requester = await issueSession({ accountId: "acct_kr_victim", clientKind: "web" });
    const attacker = await issueSession({ accountId: "acct_kr_attacker", clientKind: "web" });
    const ephPub = freshEphPub();

    await post("/v1/keys/request", requester.accessToken, { ephPub });
    const approved = await post("/v1/keys/request/approve", attacker.accessToken, {
      ephPub,
      response: "c2VhbGVk",
    });
    expect(approved.statusCode).toBe(404);
  });

  it("refuses self-approval — one session cannot both ask and answer", async () => {
    const accountId = "acct_kr_selfapprove";
    const session = await issueSession({ accountId, clientKind: "web" });
    const ephPub = freshEphPub();

    await post("/v1/keys/request", session.accessToken, { ephPub });
    const approved = await post("/v1/keys/request/approve", session.accessToken, {
      ephPub,
      response: "c2VhbGVk",
    });
    expect(approved.statusCode).toBe(404);
  });

  it("will not deliver to a DIFFERENT session of the same account", async () => {
    // An accountId match alone would let an attacker's session of the same account
    // consume a legitimate delivery, so the claim is bound to the requesting session.
    const accountId = "acct_kr_wrongsession";
    const requester = await issueSession({ accountId, clientKind: "web" });
    const holder = await issueSession({ accountId, clientKind: "cli-daemon" });
    const other = await issueSession({ accountId, clientKind: "web" });
    const ephPub = freshEphPub();

    await post("/v1/keys/request", requester.accessToken, { ephPub });
    await post("/v1/keys/request/approve", holder.accessToken, { ephPub, response: "c2VhbGVk" });

    expect((await post("/v1/keys/request/claim", other.accessToken, { ephPub })).json()).toEqual({
      state: "expired",
    });
    // …and the real requester can still collect it.
    expect(
      (await post("/v1/keys/request/claim", requester.accessToken, { ephPub })).json(),
    ).toMatchObject({ state: "ready" });
  });

  it("scopes the pending list to the caller's own account", async () => {
    const requester = await issueSession({ accountId: "acct_kr_scope_a", clientKind: "web" });
    const stranger = await issueSession({ accountId: "acct_kr_scope_b", clientKind: "web" });
    await post("/v1/keys/request", requester.accessToken, { ephPub: freshEphPub() });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/keys/requests",
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect((listed.json() as { requests: unknown[] }).requests).toHaveLength(0);
  });

  it("answers 400, not 401, for a malformed key on an authenticated route", async () => {
    // A 401 here would read as "your token is dead" to any client with a 401 interceptor
    // and trigger a spurious re-auth loop.
    const session = await issueSession({ accountId: "acct_kr_badkey", clientKind: "web" });
    const response = await post("/v1/keys/request", session.accessToken, { ephPub: "not-a-key" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unauthenticated caller on every route", async () => {
    const ephPub = freshEphPub();
    for (const [method, url, payload] of [
      ["POST", "/v1/keys/request", { ephPub }],
      ["GET", "/v1/keys/requests", undefined],
      ["POST", "/v1/keys/request/approve", { ephPub, response: "x" }],
      ["POST", "/v1/keys/request/claim", { ephPub }],
    ] as const) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode).toBe(401);
    }
  });

  it("re-POSTing the same key refreshes the request rather than no-opping", async () => {
    const accountId = "acct_kr_renew";
    const requester = await issueSession({ accountId, clientKind: "web" });
    const holder = await issueSession({ accountId, clientKind: "cli-daemon" });
    const ephPub = freshEphPub();

    await post("/v1/keys/request", requester.accessToken, { ephPub, label: "first" });
    await post("/v1/keys/request", requester.accessToken, { ephPub, label: "second" });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/keys/requests",
      headers: { authorization: `Bearer ${holder.accessToken}` },
    });
    const body = listed.json() as { requests: Array<{ label: string }> };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]?.label).toBe("second");
  });
});
