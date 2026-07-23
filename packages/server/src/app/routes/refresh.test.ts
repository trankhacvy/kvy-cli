import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashRefreshToken, issueSession, verifyToken } from "../../auth/index.js";
import { deviceSessions } from "../../db/schema.js";
import * as schema from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { buildServer } from "../server.js";
import { createTestAccount } from "./testHelpers.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

describe("POST /v1/auth/refresh", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;

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

  async function issueFor() {
    const { account } = await createTestAccount(db);
    return issueSession(db, { accountId: account.id, clientKind: "web" });
  }

  it("rotates the refresh token and mints a fresh access token on the happy path", async () => {
    const { refreshToken } = await issueFor();

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Not asserting accessToken !== the pre-refresh one: minted within the same second
    // with identical claims, the JWT is byte-identical — that's expected, not a bug.
    expect(typeof body.accessToken).toBe("string");
    expect(body.refreshToken).not.toBe(refreshToken);

    const verified = await verifyToken(body.accessToken);
    expect(verified?.accountId).toEqual(expect.any(String));
  });

  it("the rotated refresh token itself works for a subsequent refresh", async () => {
    const { refreshToken } = await issueFor();
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: first.json().refreshToken },
    });

    expect(second.statusCode).toBe(200);
  });

  it("rejects an unknown refresh token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: "not-a-real-token" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("tolerates a replay of the immediately-prior token within the grace window (multi-tab race)", async () => {
    const { refreshToken } = await issueFor();
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);

    // A sibling tab replays the now-stale (but very recently retired) token.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });

    expect(replay.statusCode).toBe(200);
    // Grace-path contract: the response echoes back the same token the caller sent,
    // it does not mint yet another rotation.
    expect(replay.json().refreshToken).toBe(refreshToken);
  });

  it("revokes the whole session family when a retired token is replayed outside the grace window (theft)", async () => {
    const { refreshToken, sessionId } = await issueFor();
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);

    // Simulate the grace window having elapsed by directly backdating previousRotatedAt.
    await db
      .update(deviceSessions)
      .set({ previousRotatedAt: new Date(Date.now() - 120_000) })
      .where(eq(deviceSessions.id, sessionId));

    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    const row = await db.query.deviceSessions.findFirst({
      where: eq(deviceSessions.id, sessionId),
    });
    expect(row?.revokedAt).not.toBeNull();

    // The rotated (and now-current) token from the first refresh is also dead —
    // the whole family was revoked, not just the replayed row.
    const rotatedRefresh = first.json().refreshToken as string;
    const rotatedHash = hashRefreshToken(rotatedRefresh);
    expect(row?.refreshTokenHash).toBe(rotatedHash);
  });

  it("rejects refresh for a revoked session", async () => {
    const { refreshToken, sessionId } = await issueFor();
    await db.update(deviceSessions).set({ revokedAt: new Date() }).where(eq(deviceSessions.id, sessionId));

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects refresh for an expired session", async () => {
    const { refreshToken, sessionId } = await issueFor();
    await db
      .update(deviceSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceSessions.id, sessionId));

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken },
    });

    expect(response.statusCode).toBe(401);
  });
});
