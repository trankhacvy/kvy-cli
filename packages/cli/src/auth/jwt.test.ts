import { describe, expect, it } from "vitest";
import { decodeTokenClaimsUnverified } from "./jwt.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${b64url({ alg: "HS256" })}.${b64url(payload)}.fake-signature`;
}

describe("decodeTokenClaimsUnverified", () => {
  it("decodes sub/exp from a well-formed JWT", () => {
    const token = fakeJwt({ sub: "acct_123", iat: 1000, exp: 2000 });
    expect(decodeTokenClaimsUnverified(token)).toEqual({ accountId: "acct_123", expiresAt: 2000 });
  });

  it("returns null for a non-JWT string", () => {
    expect(decodeTokenClaimsUnverified("not-a-jwt")).toBeNull();
  });

  it("returns null when sub is missing", () => {
    const token = fakeJwt({ exp: 2000 });
    expect(decodeTokenClaimsUnverified(token)).toBeNull();
  });

  it("returns null when exp is missing", () => {
    const token = fakeJwt({ sub: "acct_123" });
    expect(decodeTokenClaimsUnverified(token)).toBeNull();
  });

  it("returns null for a malformed base64 segment", () => {
    expect(decodeTokenClaimsUnverified("aaa.!!!not-base64!!!.bbb")).toBeNull();
  });

  it("never throws on empty input", () => {
    expect(() => decodeTokenClaimsUnverified("")).not.toThrow();
    expect(decodeTokenClaimsUnverified("")).toBeNull();
  });
});
