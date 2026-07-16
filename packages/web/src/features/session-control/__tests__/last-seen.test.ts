import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "@/lib/__tests__/test-storage.js";
import { getLastSeenAt, markSeenNow } from "../last-seen.js";

describe("last-seen (no window)", () => {
  it("getLastSeenAt/markSeenNow are safe no-ops without crashing", () => {
    expect(getLastSeenAt("sess-1")).toBeNull();
    expect(() => markSeenNow("sess-1")).not.toThrow();
  });
});

describe("last-seen (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("returns null for a session that's never been marked seen", () => {
    expect(getLastSeenAt("sess-1")).toBeNull();
  });

  it("markSeenNow persists a timestamp getLastSeenAt then returns", () => {
    markSeenNow("sess-1", 12345);
    expect(getLastSeenAt("sess-1")).toBe(12345);
  });

  it("keys are scoped per session id", () => {
    markSeenNow("sess-1", 100);
    markSeenNow("sess-2", 200);
    expect(getLastSeenAt("sess-1")).toBe(100);
    expect(getLastSeenAt("sess-2")).toBe(200);
  });

  it("a later markSeenNow overwrites the previous timestamp", () => {
    markSeenNow("sess-1", 100);
    markSeenNow("sess-1", 200);
    expect(getLastSeenAt("sess-1")).toBe(200);
  });

  it("defaults to Date.now() when no timestamp is given", () => {
    const before = Date.now();
    markSeenNow("sess-1");
    const seen = getLastSeenAt("sess-1");
    expect(seen).not.toBeNull();
    expect(seen).toBeGreaterThanOrEqual(before);
  });
});
