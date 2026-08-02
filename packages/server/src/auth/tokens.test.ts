import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_SECONDS, mintAccessToken, verifyToken } from "./tokens.js";

const secret = "test-signing-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const payload = { accountId: "acct_123", sessionId: "sess_abc", clientKind: "web" as const };

describe("mintAccessToken / verifyToken", () => {
  it("round-trips: a minted token verifies back to the same claims", async () => {
    const token = await mintAccessToken(payload, { secret });

    const result = await verifyToken(token, { secret });

    expect(result).not.toBeNull();
    expect(result?.accountId).toBe("acct_123");
    expect(result?.sessionId).toBe("sess_abc");
    expect(result?.clientKind).toBe("web");
  });

  it("sets expiresAt ACCESS_TOKEN_TTL_SECONDS in the future by default", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await mintAccessToken(payload, { secret });

    const result = await verifyToken(token, { secret });

    expect(result).not.toBeNull();
    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS);
    expect(result?.expiresAt).toBeLessThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS + 5);
  });

  it("defaults to a 15-minute TTL", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it("rejects an expired token", async () => {
    const token = await mintAccessToken(payload, { secret, ttlSeconds: -1 });

    const result = await verifyToken(token, { secret });

    expect(result).toBeNull();
  });

  it("rejects a token with a tampered payload segment", async () => {
    const token = await mintAccessToken(payload, { secret });
    const [header, tokenPayload, signature] = token.split(".");
    expect(tokenPayload).toBeDefined();
    // Flip the last character of the base64url payload — corrupts the claims without
    // producing a malformed-JSON token, so this specifically exercises signature
    // verification rather than parse failure.
    const flipped = (tokenPayload as string).endsWith("A")
      ? `${(tokenPayload as string).slice(0, -1)}B`
      : `${(tokenPayload as string).slice(0, -1)}A`;
    const tampered = [header, flipped, signature].join(".");

    const result = await verifyToken(tampered, { secret });

    expect(result).toBeNull();
  });

  it("rejects a token signed under a different secret", async () => {
    const token = await mintAccessToken(payload, { secret });

    const result = await verifyToken(token, {
      secret: "a-completely-different-secret-bbbbbbbbbbbb",
    });

    expect(result).toBeNull();
  });

  it("rejects an empty token", async () => {
    expect(await verifyToken("", { secret })).toBeNull();
  });

  it("rejects a garbage (non-JWT) token", async () => {
    expect(await verifyToken("not-a-jwt-at-all", { secret })).toBeNull();
  });

  it("rejects a token missing the sid/ct claims (a pre-issue-4 token)", async () => {
    // Simulates the legacy `mintToken(accountId)` shape — no `sid`/`ct` claims — by
    // signing a JWT directly rather than through `mintAccessToken`.
    const { SignJWT } = await import("jose");
    const legacyToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("acct_123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    expect(await verifyToken(legacyToken, { secret })).toBeNull();
  });
});
