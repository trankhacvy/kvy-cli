import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_TTL_SECONDS, mintToken, verifyToken } from "./tokens.js";

const secret = "test-signing-secret-aaaaaaaaaaaaaaaaaaaaaaaa";

describe("mintToken / verifyToken", () => {
  it("round-trips: a minted token verifies back to the same accountId", async () => {
    const token = await mintToken("acct_123", { secret });

    const result = await verifyToken(token, { secret });

    expect(result).not.toBeNull();
    expect(result?.accountId).toBe("acct_123");
  });

  it("sets expiresAt ACCESS_TOKEN_TTL_SECONDS in the future by default", async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await mintToken("acct_123", { secret });

    const result = await verifyToken(token, { secret });

    expect(result).not.toBeNull();
    expect(result?.expiresAt).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS);
    expect(result?.expiresAt).toBeLessThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS + 5);
  });

  it("defaults to a 1-hour TTL (falcon-system-design.md §5.2)", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
  });

  it("rejects an expired token", async () => {
    const token = await mintToken("acct_123", { secret, ttlSeconds: -1 });

    const result = await verifyToken(token, { secret });

    expect(result).toBeNull();
  });

  it("rejects a token with a tampered payload segment", async () => {
    const token = await mintToken("acct_123", { secret });
    const [header, payload, signature] = token.split(".");
    expect(payload).toBeDefined();
    // Flip the last character of the base64url payload — corrupts the claims without
    // producing a malformed-JSON token, so this specifically exercises signature
    // verification rather than parse failure.
    const flipped = (payload as string).endsWith("A")
      ? `${(payload as string).slice(0, -1)}B`
      : `${(payload as string).slice(0, -1)}A`;
    const tampered = [header, flipped, signature].join(".");

    const result = await verifyToken(tampered, { secret });

    expect(result).toBeNull();
  });

  it("rejects a token signed under a different secret", async () => {
    const token = await mintToken("acct_123", { secret });

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
});
