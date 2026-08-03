import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-text technique: `page.tsx` uses `next/navigation`'s `useRouter` which throws
// outside App Router context, so these assertions run against the shipped source text.
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

  // The email+password link renders unconditionally now — the server (`password.ts`'s
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
    expect(pageSource).toContain("copy.signin.oauthUnavailable");
  });

  // An unconfigured provider is an admin setup concern: its button is hidden
  // outright, never shown disabled to an end user.
  it("hides each provider's button when that provider isn't configured", () => {
    expect(pageSource).toContain("{GOOGLE_OAUTH_CLIENT_ID && (");
    expect(pageSource).toContain("{GITHUB_OAUTH_CLIENT_ID && (");
    expect(pageSource).not.toContain("disabled={!GOOGLE_OAUTH_CLIENT_ID}");
    expect(pageSource).not.toContain("disabled={!GITHUB_OAUTH_CLIENT_ID}");
  });

  // The "expired" banner is gated on the `expired` state, itself only ever set true by
  // `isExpiredReason(window.location.search)` (`./signin-gate`) in the mount
  // effect — source-text check that the wiring is what it looks like (the actual
  // parsing is covered behaviorally, without a DOM, by `signin-gate.test.ts`).
  it("renders the expiry banner gated on isExpiredReason(window.location.search)", () => {
    expect(pageSource).toContain("isExpiredReason(window.location.search)");
    expect(pageSource).toContain('setBanner("expired")');
    expect(pageSource).toContain('{banner === "expired" && (');
    expect(pageSource).toContain("copy.signin.expiredBanner");
  });

  // A visitor bounced here mid-pairing is told why. `peekPendingPair` reads WITHOUT
  // consuming — only the pair page spends it.
  it("switches its heading when a pairing is waiting", () => {
    expect(pageSource).toContain("peekPendingPair()");
    expect(pageSource).toContain('setBanner("pair")');
    expect(pageSource).toContain("copy.signin.titleWithPendingPair");
  });
});
