import { describe, expect, it } from "vitest";
import { SIGNIN_EXPIRED_PATH, SIGNIN_PATH } from "@/features/auth";
import { isExpiredReason } from "./signin-gate";

// A failed `silentRefresh()` (`require-auth.tsx`) redirects here with `SIGNIN_EXPIRED_PATH`'s
// query string, and this page must recognize exactly that as "show the expired
// banner" — while a plain unauthenticated visit (`SIGNIN_PATH`, no query string,
// the same route a deliberate "log out this device" also lands on) must not.
describe("isExpiredReason", () => {
  it("recognizes SIGNIN_EXPIRED_PATH's query string as an expired session", () => {
    const url = new URL(SIGNIN_EXPIRED_PATH, "https://example.test");
    expect(isExpiredReason(url.search)).toBe(true);
  });

  it("does not treat a plain unauthenticated visit (SIGNIN_PATH, no reason) as expired", () => {
    const url = new URL(SIGNIN_PATH, "https://example.test");
    expect(isExpiredReason(url.search)).toBe(false);
  });

  it("ignores an unrelated or malformed reason value", () => {
    expect(isExpiredReason("?reason=logged-out")).toBe(false);
    expect(isExpiredReason("")).toBe(false);
  });
});
