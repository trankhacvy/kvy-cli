import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToken, getToken, isSignedIn, setToken } from "../session.js";
import { createMemoryStorage } from "./test-storage.js";

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
    setToken("jwt-abc-123");
    expect(getToken()).toBe("jwt-abc-123");
    expect(isSignedIn()).toBe(true);
  });

  it("setToken overwrites a previously stored token", () => {
    setToken("first");
    setToken("second");
    expect(getToken()).toBe("second");
  });

  it("clearToken removes the stored token", () => {
    setToken("jwt-abc-123");
    clearToken();
    expect(getToken()).toBeNull();
    expect(isSignedIn()).toBe(false);
  });
});
