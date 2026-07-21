import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToken, getToken, isSignedIn, isTokenExpired, setToken } from "../session.js";
import { createMemoryStorage } from "./test-storage.js";

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
 * `session.ts` guards every call on `typeof window !== "undefined"` —
 * exercised here in both configurations this vitest run (environment:
 * "node", no jsdom) can actually hit: no `window` at all (SSR/build time,
 * `typeof window` on an unbound identifier is safe and resolves to
 * "undefined"), and a `window` with a `localStorage` stand-in (the
 * post-hydration browser case these pages actually run in).
 */
describe("session (no window)", () => {
  it("getToken/isSignedIn/clearToken/setToken are all safe no-ops without crashing", () => {
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
    expect(() => setToken("abc")).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });

  it("isTokenExpired() is true with no window at all (nothing valid to trust)", () => {
    expect(isTokenExpired()).toBe(true);
  });
});

describe("session (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("getToken returns null before any token is set", () => {
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
  });

  it("setToken persists a token that getToken/isSignedIn then observe", () => {
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));
    expect(getToken()).not.toBeNull();
    expect(isSignedIn()).toBe(true);
  });

  it("setToken overwrites a previously stored token", () => {
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP, sub: "first" }));
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP, sub: "second" }));
    const stored = getToken();
    if (!stored) throw new Error("expected a stored token");
    const payloadPart = stored.split(".")[1];
    if (!payloadPart) throw new Error("expected a JWT-shaped token");
    expect(JSON.parse(Buffer.from(payloadPart, "base64").toString("utf8")).sub).toBe("second");
  });

  it("clearToken removes the stored token", () => {
    setToken(fakeJwt({ exp: FAR_FUTURE_EXP }));
    clearToken();
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
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
});
