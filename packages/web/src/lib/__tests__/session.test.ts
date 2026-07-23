import { afterEach, describe, expect, it, vi } from "vitest";

const { getSharedCryptoBridgeMock } = vi.hoisted(() => ({
  getSharedCryptoBridgeMock: vi.fn(),
}));

vi.mock("../use-crypto-bridge.js", () => ({
  getSharedCryptoBridge: getSharedCryptoBridgeMock,
}));

const { clearToken, getAccountId, getToken, isSignedIn, isTokenExpired, setToken, silentRefresh } =
  await import("../session.js");

/** Base64url-encodes a JSON payload the same way a real JWT would, so tests
 * can build a fake-but-shaped token without pulling in a real JWT library
 * (session.ts's own `decodeJwtExp` never verifies the signature, so the
 * header/signature segments below are just placeholder text). */
function fakeJwt(payload: Record<string, unknown>): string {
  const base64url = (json: string) =>
    Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(payload),
  )}.signature`;
}

const FAR_FUTURE_EXP = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // ~1 year out
const PAST_EXP = Math.floor(Date.now() / 1000) - 60; // 1 minute ago

/**
 * Security review finding F1: the access token now lives in a plain in-memory
 * module variable (`session.ts`) — never `localStorage` — so these tests just
 * drive `setToken`/`getToken`/`clearToken` directly, no `window`/storage
 * stand-in needed (an earlier revision of this suite stubbed
 * `window.localStorage`, back when that's where the token actually lived).
 */
describe("session", () => {
  afterEach(() => {
    clearToken();
    getSharedCryptoBridgeMock.mockReset();
  });

  it("getToken returns null before any token is set", () => {
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
  });

  it("setToken makes a token that getToken/isSignedIn then observe", () => {
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));
    expect(getToken()).not.toBeNull();
    expect(isSignedIn()).toBe(true);
  });

  it("setToken overwrites a previously set token", () => {
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP, sub: "first" }));
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP, sub: "second" }));
    expect(getAccountId()).toBe("second");
  });

  it("clearToken removes the set token", () => {
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));
    clearToken();
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
  });

  describe("getAccountId", () => {
    it("returns null when no token is set", () => {
      expect(getAccountId()).toBeNull();
    });

    it("returns the token's sub claim", () => {
      setToken(fakeJwt({ sub: "acct-123", exp: FAR_FUTURE_EXP }));
      expect(getAccountId()).toBe("acct-123");
    });

    it("returns null for a malformed token", () => {
      setToken("not-a-jwt");
      expect(getAccountId()).toBeNull();
    });

    it("returns null when sub is missing or empty", () => {
      setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));
      expect(getAccountId()).toBeNull();
      setToken(fakeJwt({ sub: "", exp: FAR_FUTURE_EXP }));
      expect(getAccountId()).toBeNull();
    });
  });

  describe("isTokenExpired / isSignedIn", () => {
    it("no token at all -> expired, not signed in", () => {
      expect(isTokenExpired()).toBe(true);
      expect(isSignedIn()).toBe(false);
    });

    it("a token with a far-future exp -> not expired, signed in", () => {
      setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));
      expect(isTokenExpired()).toBe(false);
      expect(isSignedIn()).toBe(true);
    });

    it("a token with a past exp -> expired, not signed in", () => {
      setToken(fakeJwt({ exp: PAST_EXP }));
      expect(isTokenExpired()).toBe(true);
      expect(isSignedIn()).toBe(false);
    });

    it("a token with exp exactly now -> treated as expired (>=, not >)", () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      setToken(fakeJwt({ exp: nowSeconds }));
      expect(isTokenExpired()).toBe(true);
    });

    it("a malformed token (not 3 dot-separated segments) -> treated as expired, not thrown", () => {
      setToken("not-a-real-jwt");
      expect(() => isTokenExpired()).not.toThrow();
      expect(isTokenExpired()).toBe(true);
      expect(isSignedIn()).toBe(false);
    });

    it("a token whose payload segment isn't valid base64/JSON -> treated as expired, not thrown", () => {
      setToken("header.%%%not-base64%%%.signature");
      expect(() => isTokenExpired()).not.toThrow();
      expect(isTokenExpired()).toBe(true);
    });

    it("a token whose payload has no exp claim -> treated as expired", () => {
      setToken(fakeJwt({ sub: "user-1" }));
      expect(isTokenExpired()).toBe(true);
    });

    it("a token whose exp claim isn't a number -> treated as expired", () => {
      setToken(fakeJwt({ exp: "not-a-number" }));
      expect(isTokenExpired()).toBe(true);
    });

    it("a token with too many dot-separated segments -> treated as expired, not thrown", () => {
      setToken("a.b.c.d");
      expect(() => isTokenExpired()).not.toThrow();
      expect(isTokenExpired()).toBe(true);
    });

    it("a token with an empty payload segment ('a..b') -> treated as expired, not thrown", () => {
      setToken("a..b");
      expect(() => isTokenExpired()).not.toThrow();
      expect(isTokenExpired()).toBe(true);
    });
  });

  describe("silentRefresh (security review finding F1)", () => {
    it("resolves false without touching the token when no unlocked bridge is available", async () => {
      getSharedCryptoBridgeMock.mockReturnValue(null);
      setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));

      const result = await silentRefresh();

      expect(result).toBe(false);
      // No bridge to ask -> the existing (possibly still-valid) token is left alone,
      // not wiped out from under an otherwise-fine session.
      expect(getToken()).not.toBeNull();
    });

    it("mints a fresh access token from the bridge and never touches the refresh token itself", async () => {
      const refreshSessionMock = vi.fn().mockResolvedValue("fresh-access-token");
      getSharedCryptoBridgeMock.mockReturnValue({ refreshSession: refreshSessionMock });

      const result = await silentRefresh();

      expect(result).toBe(true);
      expect(getToken()).toBe("fresh-access-token");
      expect(refreshSessionMock).toHaveBeenCalledWith();
    });

    it("clears the token and resolves false when the bridge has nothing to refresh with", async () => {
      const refreshSessionMock = vi.fn().mockResolvedValue(null);
      getSharedCryptoBridgeMock.mockReturnValue({ refreshSession: refreshSessionMock });
      setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));

      const result = await silentRefresh();

      expect(result).toBe(false);
      expect(getToken()).toBeNull();
    });
  });
});
