import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccountId } from "./session";

/** Builds an unsigned-by-us JWT-shaped string — `getAccountId` never verifies
 * signatures (UX read only, same as `isTokenExpired`), so a hand-rolled
 * base64url payload is enough to exercise it. */
function fakeJwt(payload: unknown): string {
  const b64url = (value: string) =>
    btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccountId", () => {
  it("returns null when no token is stored", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    expect(getAccountId()).toBeNull();
  });

  it("returns the token's sub claim", () => {
    const token = fakeJwt({ sub: "acct-123", exp: 2000000000 });
    vi.stubGlobal("window", { localStorage: { getItem: () => token } });
    expect(getAccountId()).toBe("acct-123");
  });

  it("returns null for a malformed token", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "not-a-jwt" } });
    expect(getAccountId()).toBeNull();
  });

  it("returns null when sub is missing or empty", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => fakeJwt({ exp: 2000000000 }) },
    });
    expect(getAccountId()).toBeNull();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => fakeJwt({ sub: "" }) },
    });
    expect(getAccountId()).toBeNull();
  });
});
