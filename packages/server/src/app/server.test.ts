import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestAccount, createTestDb } from "./routes/testHelpers.js";
import { buildServer } from "./server.js";

describe("buildServer", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("responds 200 with a healthy payload on GET /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      status: "ok",
      uptimeSeconds: expect.any(Number),
      timestamp: expect.any(String),
    });
  });

  it("404s on an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });

  it("returns JSON content-type on /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("only exposes the fields declared in the response schema", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp", "uptimeSeconds"]);
  });

  it("405s (or 404s) on POST /health since only GET is registered", async () => {
    const response = await app.inject({ method: "POST", url: "/health" });
    expect([404, 405]).toContain(response.statusCode);
  });
});

// Split-origin self-host shape (kvy-system-design.md §5.3/§9, plan.md §16 "4.3
// Distribution & self-host"): the web static export is served from a different origin
// than this API, so plain HTTP routes — not just the Socket.IO `/v1/stream` path — need a
// real CORS allowlist too. `CORS_ALLOWED_ORIGINS` defaults to `http://localhost:3000`
// (config.ts) when unset, which is what these tests exercise.
describe("buildServer CORS (HTTP routes)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("reflects an allowlisted Origin on a simple GET", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("omits the CORS header for a non-allowlisted Origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never sets Access-Control-Allow-Credentials (bearer-token auth, no cookies to leak)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers an allowlisted preflight OPTIONS with the allowed methods/headers", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("rejects a preflight OPTIONS from a non-allowlisted origin", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "GET",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("buildServer rate limiting", () => {
  let pglite: PGlite;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let app: FastifyInstance;

  beforeAll(async () => {
    const created = await createTestDb();
    db = created.db;
    pglite = created.pglite;
    app = await buildServer({ logger: false }, { db });
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  // Regression test for the account-keyed rate limit (server.ts's
  // `keyGenerator: (req) => req.accountId || req.ip`): the global rate-limit
  // plugin must run as a `preHandler` (not its default `onRequest`), because
  // `app.authenticate` — the thing that actually sets `req.accountId` — is
  // itself only wired in as a route `preHandler`. With the default
  // `onRequest` hook, `req.accountId` is always unset when the key generator
  // runs, so every authenticated account silently falls back to IP-only
  // keying (two accounts behind the same IP/NAT would then share one
  // bucket, the exact starvation this design explicitly says it avoids).
  it("gives each authenticated account its own rate-limit bucket, not a shared IP bucket", async () => {
    const accountA = await createTestAccount(db);
    const accountB = await createTestAccount(db);

    // app.inject() requests all share the same fake IP, so if the key
    // generator ever fell back to `req.ip` for these authenticated
    // requests, account B's first request would report the same
    // "remaining" count as account A's *second* request instead of its own
    // first — i.e. a shared, not per-account, bucket.
    const firstA = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: accountA.authHeader },
    });
    const secondA = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: accountA.authHeader },
    });
    const firstB = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: accountB.authHeader },
    });

    const remaining = (res: typeof firstA) => Number(res.headers["x-ratelimit-remaining"]);

    expect(firstA.statusCode).toBe(200);
    expect(secondA.statusCode).toBe(200);
    expect(firstB.statusCode).toBe(200);
    expect(remaining(secondA)).toBe(remaining(firstA) - 1);
    // Account B's first request must land at the *same* remaining count as
    // account A's first request, not one less — proving it got its own
    // bucket instead of continuing to drain account A's.
    expect(remaining(firstB)).toBe(remaining(firstA));
  });
});
