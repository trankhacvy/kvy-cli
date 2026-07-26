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
    const refreshedIndex = source.indexOf("const result = await silentRefresh();");
    expect(refreshedIndex).toBeGreaterThan(-1);
    // Formatting-agnostic: whatever the branch shape, the FAILURE arm must land on the
    // reason-carrying path so /signin/ can explain itself instead of looking like a bare
    // cold visit.
    const afterRefresh = source.slice(refreshedIndex).replace(/\s+/g, " ");
    expect(afterRefresh).toContain("router.replace(SIGNIN_EXPIRED_PATH)");
    expect(afterRefresh).not.toContain("router.replace(SIGNIN_PATH)");
  });

  it('only a "signed-out" outcome triggers the redirect — "unreachable" must not', () => {
    const refreshedIndex = source.indexOf("const result = await silentRefresh();");
    const afterRefresh = source.slice(refreshedIndex).replace(/\s+/g, " ");
    expect(afterRefresh).toMatch(/result === "signed-out"\)\s*\{?\s*router\.replace/);
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
describe("require-auth.tsx — key-state wiring (docs/auth-ux-overhaul-plan.md Phase 4a/5)", () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../require-auth.tsx"),
    "utf-8",
  );

  it("offers to fetch keys rather than dead-ending a browser that has none", () => {
    const noKeysIndex = source.indexOf('status.kind === "no-keys"');
    expect(noKeysIndex).toBeGreaterThan(-1);
    expect(source.slice(noKeysIndex, noKeysIndex + 400)).toContain("RequestKeysPanel");
  });

  it("has no PIN gate left", () => {
    expect(source).not.toContain("PinUnlockForm");
    expect(source).not.toContain("needs-unlock");
    expect(source).not.toContain("onForgotPin");
  });

  it("checks the session independently of key material", () => {
    // Phase 4a: gating the session effect on crypto readiness made "signed in but no
    // keys" unreachable — the exact state RequestKeysPanel has to run in.
    const effectIndex = source.indexOf("async function ensureSession()");
    expect(effectIndex).toBeGreaterThan(-1);
    const beforeEffect = source.slice(0, effectIndex);
    expect(beforeEffect).not.toContain('if (status.kind !== "ready") return;');
  });

  it("mounts the key-request approve listener for signed-in users", () => {
    expect(source).toContain("KeyRequestListener");
  });
});
