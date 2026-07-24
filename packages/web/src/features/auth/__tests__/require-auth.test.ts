import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SIGNIN_EXPIRED_PATH, SIGNIN_PATH, shouldRedirectToSignin } from "../require-auth";

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

// docs/auth-ux-hardening-plan.md item 7 ("session-expiry-reason"): a failed silent
// refresh must carry a reason so `/signin/` can explain why the visitor landed there,
// instead of looking indistinguishable from a bare cold visit.
describe("SIGNIN_EXPIRED_PATH", () => {
  it("is the sign-in route with an explicit expired-session reason", () => {
    expect(SIGNIN_EXPIRED_PATH).toBe("/signin/?reason=expired");
  });

  it("is a distinct constant from the plain SIGNIN_PATH used for deliberate logouts", () => {
    expect(SIGNIN_EXPIRED_PATH).not.toBe(SIGNIN_PATH);
    expect(SIGNIN_EXPIRED_PATH.startsWith(SIGNIN_PATH)).toBe(true);
  });
});

describe("require-auth.tsx — failed-refresh redirect wiring", () => {
  // No DOM environment in this package (see file header) means the effect that
  // actually calls `silentRefresh()` and `router.replace(...)` can't be exercised
  // by mounting the component — asserted against the shipped source text instead,
  // same technique the `/reset-keys/` wiring tests below use.
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../require-auth.tsx"),
    "utf-8",
  );

  it("a failed silentRefresh() redirects to SIGNIN_EXPIRED_PATH, not plain SIGNIN_PATH", () => {
    const refreshedIndex = source.indexOf("const refreshed = await silentRefresh();");
    expect(refreshedIndex).toBeGreaterThan(-1);
    const afterRefresh = source.slice(refreshedIndex);
    const elseIndex = afterRefresh.indexOf("} else {");
    expect(elseIndex).toBeGreaterThan(-1);
    const redirectBlock = afterRefresh.slice(elseIndex, afterRefresh.indexOf("}", elseIndex + 8));
    expect(redirectBlock).toContain("router.replace(SIGNIN_EXPIRED_PATH);");
    expect(redirectBlock).not.toContain("router.replace(SIGNIN_PATH);");
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

// docs/auth-ux-hardening-plan.md item 2d: the `no-identity` dead-end and the
// `needs-unlock` "Forgot your PIN?" link both now route to the provider-agnostic
// `/reset-keys/` route instead of `/password/` (dev-only in production, per item 3).
// Asserted against the shipped source text, same technique `signin/page.test.ts` and
// `(protected)/layout.test.ts` use for hook-heavy JSX this vitest config can't render.
describe("require-auth.tsx — /reset-keys/ wiring", () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../require-auth.tsx"),
    "utf-8",
  );

  it("the no-identity dead-end offers a button to /reset-keys/", () => {
    const noIdentityIndex = source.indexOf('status.kind === "no-identity"');
    const needsUnlockIndex = source.indexOf('status.kind === "needs-unlock"');
    expect(noIdentityIndex).toBeGreaterThan(-1);
    expect(needsUnlockIndex).toBeGreaterThan(noIdentityIndex);
    const noIdentityBlock = source.slice(noIdentityIndex, needsUnlockIndex);
    expect(noIdentityBlock).toContain('router.push("/reset-keys/")');
  });

  it('"Forgot your PIN?" (onForgotPin) repoints to /reset-keys/, not /password/', () => {
    expect(source).toContain('onForgotPin={() => router.push("/reset-keys/")}');
    expect(source).not.toContain('onForgotPin={() => router.push("/password/")}');
  });
});
