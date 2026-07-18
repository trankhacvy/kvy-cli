import { describe, expect, it } from "vitest";
import { shouldRedirectToSignin, SIGNIN_PATH } from "../require-auth";

describe("shouldRedirectToSignin", () => {
  it("redirects a signed-out visitor", () => {
    expect(shouldRedirectToSignin(false)).toBe(true);
  });

  it("does not redirect a signed-in visitor", () => {
    expect(shouldRedirectToSignin(true)).toBe(false);
  });
});

describe("SIGNIN_PATH", () => {
  it("matches the sign-in route every other hand-rolled gate (app/page.tsx et al.) redirects to", () => {
    expect(SIGNIN_PATH).toBe("/signin/");
  });
});
