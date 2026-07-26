import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `page.tsx` can't be rendered directly under this package's `environment:
 * "node"` vitest config: it's a full page component using `next/navigation`'s
 * `useRouter` (throws outside an actual App Router context), neither of which
 * has a lightweight fake here. Asserting against the shipped source text is
 * the same technique `SessionTimelineScreen.test.tsx` uses for similarly
 * hook-heavy, non-pulled-out JSX.
 *
 * issue-4-plan.md §5.5/Phase 4: the legacy challenge-sign-in + recovery-code
 * restore paths are gone from this page — it's OAuth buttons plus a link to
 * `/password/`, nothing that reads local key material before a login click.
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

describe("signin/page.tsx", () => {
  it("no longer references the deleted recovery-code / challenge-sign-in modules", () => {
    expect(pageSource).not.toContain("recovery-code-input");
    expect(pageSource).not.toContain("RecoveryCodeInput");
    expect(pageSource).not.toContain("complete-challenge-sign-in");
    expect(pageSource).not.toContain("restore-handler");
    expect(pageSource).not.toContain("completeChallengeSignIn");
  });

  it("offers Google/GitHub OAuth and links to the email+password page", () => {
    expect(pageSource).toContain("Continue with Google");
    expect(pageSource).toContain("Continue with GitHub");
    expect(pageSource).toContain('router.push("/password/")');
  });

  // docs/auth-ux-hardening-plan.md item 3 ("gate-password-prod"): the email+password
  // link renders unconditionally now — the server (`password.ts`'s
  // `requireNonProduction`) is what actually 404s the underlying routes in
  // production, so the client no longer needs (or has) a matching build-time flag.
  // The dev-only OAuth bypass is gone entirely, not just ungated.
  it("always offers the email+password link and no longer has a dev-only OAuth bypass", () => {
    expect(pageSource).toContain('router.push("/password/")');
    expect(pageSource).not.toContain("/auth/callback/dev/");
    expect(pageSource).not.toContain("DEV_AUTH_ENABLED");
  });

  it("only shows the 'no OAuth provider configured' note when neither OAuth provider is available", () => {
    expect(pageSource).toContain("!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID");
    expect(pageSource).toContain("No OAuth provider is configured for this deployment.");
  });

  // docs/auth-ux-hardening-plan.md item 7 ("session-expiry-reason"): the "expired"
  // banner is gated on the `expired` state, itself only ever set true by
  // `isExpiredReason(window.location.search)` (`./signin-gate`) in the mount
  // effect — source-text check that the wiring is what it looks like (the actual
  // parsing is covered behaviorally, without a DOM, by `signin-gate.test.ts`).
  it("renders the expiry banner gated on isExpiredReason(window.location.search)", () => {
    expect(pageSource).toContain("isExpiredReason(window.location.search)");
    expect(pageSource).toContain('setBanner("expired")');
    expect(pageSource).toContain('{banner === "expired" && (');
    expect(pageSource).toContain("copy.signin.expiredBanner");
  });

  // AX-2.5: a visitor bounced here mid-pairing is told why, instead of seeing a bare
  // sign-in page. `peekPendingPair` reads WITHOUT consuming — only the pair page spends it.
  it("switches its heading when a pairing is waiting", () => {
    expect(pageSource).toContain("peekPendingPair()");
    expect(pageSource).toContain('setBanner("pair")');
    expect(pageSource).toContain("copy.signin.titleWithPendingPair");
  });
});
