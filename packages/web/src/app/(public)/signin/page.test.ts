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
  // link (and the dev-only "Continue without OAuth" bypass beside it) must be gated
  // behind the same `DEV_AUTH_ENABLED` flag the server's `FALCON_DEV_AUTH` mirrors —
  // a production build (`DEV_AUTH_ENABLED=false`) must not render a clickable path to
  // an endpoint that 404s. Still source-text-based (see file header): asserts the
  // email+password link and the dev-bypass button both sit textually inside the
  // `{DEV_AUTH_ENABLED && (...)}` block, not just gated individually.
  it("gates both the email+password link and the dev-only OAuth bypass behind DEV_AUTH_ENABLED", () => {
    const gateStart = pageSource.indexOf("{DEV_AUTH_ENABLED && (");
    expect(gateStart).toBeGreaterThan(-1);

    const passwordLinkIndex = pageSource.indexOf('router.push("/password/")');
    const devBypassIndex = pageSource.indexOf('router.push("/auth/callback/dev/")');
    expect(passwordLinkIndex).toBeGreaterThan(gateStart);
    expect(devBypassIndex).toBeGreaterThan(gateStart);

    // The Google/GitHub OAuth buttons themselves must NOT be inside that gate — they
    // render unconditionally, before the flag check even appears in the source.
    const googleIndex = pageSource.indexOf("Continue with Google");
    const githubIndex = pageSource.indexOf("Continue with GitHub");
    expect(googleIndex).toBeGreaterThan(-1);
    expect(googleIndex).toBeLessThan(gateStart);
    expect(githubIndex).toBeLessThan(gateStart);
  });

  it("only shows the 'no OAuth provider configured' note when neither OAuth nor dev auth is available", () => {
    expect(pageSource).toContain(
      "!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && !DEV_AUTH_ENABLED",
    );
    expect(pageSource).toContain("No OAuth provider is configured for this deployment.");
  });
});
