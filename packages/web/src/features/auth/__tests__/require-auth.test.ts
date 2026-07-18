import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SIGNIN_PATH, shouldRedirectToSignin } from "../require-auth";

// `next/navigation`'s `useRouter` throws ("invariant expected app router to
// be mounted") outside a real Next.js app-router tree, and this package has
// no DOM/router-harness test environment (see vitest.config.ts) — mocked
// here purely so `RequireAuth` (below) can be rendered at all via
// `renderToStaticMarkup`, matching `app/__tests__/error.test.ts`'s existing
// no-DOM-needed technique.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

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

describe("RequireAuth", () => {
  it("never renders children on the pre-effect pass, signed in or not (no content flash)", async () => {
    // `renderToStaticMarkup` renders synchronously without running effects
    // (react-dom/server never flushes `useEffect`), so this exercises
    // exactly the frame a real client-side navigation paints before the
    // gate's effect has had a chance to run and flip `checked` — the
    // scenario the component's doc comment says must never show
    // `children`, regardless of which way `isSignedIn()` will resolve.
    const { RequireAuth } = await import("../require-auth");
    const html = renderToStaticMarkup(
      createElement(RequireAuth, null, createElement("div", null, "secret session content")),
    );
    expect(html).toBe("");
    expect(html).not.toContain("secret session content");
  });
});
