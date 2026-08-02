import { randomBytes } from "node:crypto";
import { decodeBase64, encodeBase64 } from "@kvy/crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintAccessToken } from "../../auth/index.js";
import { db } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { accounts, pairRequests } from "../../db/schema.js";
import { isDatabaseAvailable } from "../../db/testDbAvailable.js";
import { buildServer } from "../server.js";

// Integration test: exercises the real pairing dance against Postgres (the routes are
// nothing but DB reads/writes). Skips itself — rather than failing the suite — when no
// reachable Postgres is configured via DATABASE_URL, matching seq.test.ts's pattern.
const dbAvailable = await isDatabaseAvailable(db);
if (dbAvailable) {
  await runMigrations();
}

afterAll(async () => {
  if (dbAvailable) {
    await db.$client.end();
  }
});

function freshEphPub(): string {
  return encodeBase64(new Uint8Array(randomBytes(32)));
}

// The approve/mint routes now internally call `issueSession`, which inserts a real
// `device_sessions` row FK'd to `accounts.id` — so the bearer token exercising them must
// belong to a real account row, not just an arbitrary well-formed JWT subject.
async function createAccountAndToken(): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ signPublicKey: `test-${randomBytes(16).toString("hex")}` })
    .returning({ id: accounts.id });
  if (!account) throw new Error("createAccountAndToken: insert returned no row");
  return mintAccessToken({ accountId: account.id, sessionId: "sess_test", clientKind: "web" });
}

describe.skipIf(!dbAvailable)("pairing routes (requires Postgres)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  function pair(ephPub: string) {
    return app.inject({ method: "POST", url: "/v1/auth/pair", payload: { ephPub } });
  }

  function status(ephPub: string) {
    return app.inject({
      method: "GET",
      url: `/v1/auth/pair/status?ephPub=${encodeURIComponent(ephPub)}`,
    });
  }

  function mint(ephPub: string, token: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/pair/mint",
      headers: { authorization: `Bearer ${token}` },
      payload: { ephPub },
    });
  }

  function approve(ephPub: string, response: Uint8Array, token: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/pair/approve",
      headers: { authorization: `Bearer ${token}` },
      payload: { ephPub, response: encodeBase64(response) },
    });
  }

  describe("POST /v1/auth/pair", () => {
    it("401s on a malformed public key", async () => {
      const response = await pair("not-a-valid-x25519-key");
      expect(response.statusCode).toBe(401);
    });

    it("creates a pending request for a fresh ephPub", async () => {
      const response = await pair(freshEphPub());

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ state: "pending" });
    });

    it("is idempotent: re-posting the same ephPub stays pending, no second row", async () => {
      const ephPub = freshEphPub();
      const first = await pair(ephPub);
      const second = await pair(ephPub);

      expect(first.json()).toEqual({ state: "pending" });
      expect(second.json()).toEqual({ state: "pending" });

      const rows = await db.select().from(pairRequests).where(eq(pairRequests.ephPub, ephPub));
      expect(rows).toHaveLength(1); // upsert, not a second row
    });

    it("reports expired once the TTL has passed, without ever being approved", async () => {
      const ephPub = freshEphPub();
      await db.insert(pairRequests).values({ ephPub, expiresAt: new Date(Date.now() - 1000) });

      const response = await pair(ephPub);
      expect(response.json()).toEqual({ state: "expired" });
    });
  });

  describe("GET /v1/auth/pair/status", () => {
    it("reports not_found for an unknown (but well-formed) ephPub", async () => {
      const response = await status(freshEphPub());
      expect(response.json()).toEqual({ status: "not_found" });
    });

    it("reports not_found for a malformed ephPub (never leaks a 401 here)", async () => {
      const response = await status("garbage");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "not_found" });
    });

    it("reports pending for a live request", async () => {
      const ephPub = freshEphPub();
      await pair(ephPub);

      const response = await status(ephPub);
      // this asserts the status specifically rather than the whole envelope.
      expect(response.json()).toMatchObject({ status: "pending" });
    });

    it("reports expired past the TTL", async () => {
      const ephPub = freshEphPub();
      await db.insert(pairRequests).values({ ephPub, expiresAt: new Date(Date.now() - 1000) });

      const response = await status(ephPub);
      expect(response.json()).toEqual({ status: "expired" });
    });
  });

  describe("POST /v1/auth/pair/mint", () => {
    it("401s without an Authorization header", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/pair/mint",
        payload: { ephPub: freshEphPub() },
      });
      expect(response.statusCode).toBe(401);
    });

    it("404s when no matching pair request exists", async () => {
      const token = await createAccountAndToken();
      const response = await mint(freshEphPub(), token);
      expect(response.statusCode).toBe(404);
    });

    it("410s when the pair request has expired", async () => {
      const ephPub = freshEphPub();
      await db.insert(pairRequests).values({ ephPub, expiresAt: new Date(Date.now() - 1000) });
      const token = await createAccountAndToken();

      const response = await mint(ephPub, token);
      expect(response.statusCode).toBe(410);
    });

    it("mints a fresh refresh token for a pending request, without touching the row", async () => {
      const ephPub = freshEphPub();
      await pair(ephPub);
      const token = await createAccountAndToken();

      const response = await mint(ephPub, token);
      expect(response.statusCode).toBe(200);
      expect(typeof response.json().refreshToken).toBe("string");

      // Nothing was persisted onto the pair request itself — the refresh token only
      // ever exists in the approving browser's memory until it's sealed.
      const [row] = await db.select().from(pairRequests).where(eq(pairRequests.ephPub, ephPub));
      expect(row?.response).toBeNull();
      expect(row?.state).toBe("pending");
    });
  });

  describe("POST /v1/auth/pair/approve", () => {
    it("401s without an Authorization header", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/pair/approve",
        payload: { ephPub: freshEphPub(), response: encodeBase64(new Uint8Array([1, 2, 3])) },
      });
      expect(response.statusCode).toBe(401);
    });

    it("404s when no matching pair request exists", async () => {
      const token = await createAccountAndToken();
      const response = await approve(freshEphPub(), new Uint8Array([1, 2, 3]), token);
      expect(response.statusCode).toBe(404);
    });

    it("410s when the pair request has expired", async () => {
      const ephPub = freshEphPub();
      await db.insert(pairRequests).values({ ephPub, expiresAt: new Date(Date.now() - 1000) });
      const token = await createAccountAndToken();

      const response = await approve(ephPub, new Uint8Array([1, 2, 3]), token);
      expect(response.statusCode).toBe(410);
    });

    it("approves a request, and the sealed box becomes pollable exactly once", async () => {
      const ephPub = freshEphPub();
      await pair(ephPub);

      const approverToken = await createAccountAndToken();
      const sealedBox = new Uint8Array([9, 8, 7, 6, 5]);
      const approveResponse = await approve(ephPub, sealedBox, approverToken);
      expect(approveResponse.statusCode).toBe(200);
      expect(approveResponse.json()).toEqual({ success: true });

      const statusResponse = await status(ephPub);
      expect(statusResponse.json()).toMatchObject({ status: "authorized" });

      const poll = await pair(ephPub);
      const body = poll.json() as { state: string; response?: string; token?: string };
      expect(body.state).toBe("authorized");
      expect(decodeBase64(body.response ?? "")).toEqual(sealedBox);
      // No plaintext token/refreshToken field exists on this response at all anymore
      expect(body.token).toBeUndefined();

      // Single-use: the row is deleted the moment it's picked up — polling again
      // starts a brand-new (unauthorized) pairing attempt for the same ephPub rather
      // than ever re-serving the same sealed box.
      const secondPoll = await pair(ephPub);
      expect(secondPoll.json()).toEqual({ state: "pending" });
    });

    it("first-approval-wins: a second approve does not overwrite the sealed box", async () => {
      const ephPub = freshEphPub();
      await pair(ephPub);

      const firstBox = new Uint8Array([1, 1, 1]);
      const secondBox = new Uint8Array([2, 2, 2]);
      const tokenA = await createAccountAndToken();
      const tokenB = await createAccountAndToken();

      const first = await approve(ephPub, firstBox, tokenA);
      const second = await approve(ephPub, secondBox, tokenB);

      // Both calls report success (idempotent from the caller's perspective — Happy does
      // the same), but only the first writer's box is actually stored.
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const [row] = await db.select().from(pairRequests).where(eq(pairRequests.ephPub, ephPub));
      const stored = row?.response ? new Uint8Array(row.response) : row?.response;
      expect(stored).toEqual(firstBox);
    });
  });
});
