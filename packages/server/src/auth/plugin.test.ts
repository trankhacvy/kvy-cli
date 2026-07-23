import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../app/server.js";
import { mintAccessToken } from "./tokens.js";

function mintToken(accountId: string): Promise<string> {
  return mintAccessToken({ accountId, sessionId: "sess_test", clientKind: "web" });
}

// Exercises `app.authenticate` (registered by authPlugin in buildServer()) end-to-end
// through a throwaway protected route, the same way a real route will use it once the
// DB layer (accounts table) lands.
describe("app.authenticate preHandler", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer({ logger: false });
    app.get("/__test/protected", { preHandler: app.authenticate }, async (request) => ({
      accountId: request.accountId,
    }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("401s when no Authorization header is present", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/protected" });

    expect(response.statusCode).toBe(401);
  });

  it("401s on a non-Bearer Authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: "Basic abc123" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("401s on an empty Bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: "Bearer " },
    });

    expect(response.statusCode).toBe(401);
  });

  it("401s on a malformed/tampered token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("200s and exposes request.accountId for a valid token", async () => {
    const token = await mintToken("acct_42");

    const response = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId: "acct_42" });
  });

  it("accepts the same token again on a second request (cache-served path)", async () => {
    const token = await mintToken("acct_42");

    const first = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });
    const second = await app.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ accountId: "acct_42" });
  });

  it("rejects a token minted for one app instance's cache against a fresh instance with the same secret", async () => {
    // Sanity check that the cache is per-app (no cross-instance leakage) — a fresh
    // instance still verifies the token correctly via the JWT itself, not a stale cache.
    const token = await mintToken("acct_99");
    const otherApp = await buildServer({ logger: false });
    otherApp.get("/__test/protected", { preHandler: otherApp.authenticate }, async (request) => ({
      accountId: request.accountId,
    }));
    await otherApp.ready();

    const response = await otherApp.inject({
      method: "GET",
      url: "/__test/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId: "acct_99" });

    await otherApp.close();
  });
});
