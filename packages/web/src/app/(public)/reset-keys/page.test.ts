import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `page.tsx` can't be rendered directly under this package's `environment: "node"` vitest
 * config: it's a full page component using `next/navigation`'s `useRouter` (throws outside an
 * actual App Router context) — same technique `app/(public)/signin/page.test.ts` and
 * `app/(protected)/layout.test.ts` use for similarly hook-heavy, non-pulled-out JSX. The
 * phase-transition logic that CAN be pulled out lives in `lib/reset-keys-phase.ts` and is
 * tested directly there (`lib/__tests__/reset-keys-phase.test.ts`).
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

/**
 * The doc comments in `page.tsx` deliberately name `useUnlockedCryptoBridge` and
 * `sessionStorage` when explaining what NOT to do (review Problem 3, F1) — those mentions
 * would otherwise false-positive the "the code never does X" assertions below. Strip
 * comments so those assertions check the actual code, not its documentation.
 */
const codeOnlySource = pageSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("reset-keys/page.tsx", () => {
  it("uses the raw useCryptoBridge(), not useUnlockedCryptoBridge() (review Problem 3)", () => {
    // This page must call `bridge.init(...)` from states useUnlockedCryptoBridge()'s "ready"
    // status never carries a bridge for (no-identity / needs-unlock) — see
    // docs/auth-ux-hardening-plan.md item 2b.
    expect(pageSource).toContain("useCryptoBridge");
    expect(codeOnlySource).not.toContain("useUnlockedCryptoBridge");
  });

  it("gates only on bridge presence, not on an unlock-status kind", () => {
    expect(pageSource).toContain("if (!bridge) return");
  });

  it("offers key sharing as primary and reset as a demoted, confirm-gated secondary action", () => {
    expect(pageSource).toContain("copy.reset.fetchKeysCta");
    expect(pageSource).toContain("copy.reset.resetInsteadCta");
    expect(pageSource).toContain("confirmingReset");
    expect(pageSource).toContain("Confirm with Google");
    expect(pageSource).toContain("Confirm with GitHub");
  });

  // The destructive confirm box used to only offer Google/GitHub step-up — with neither
  // configured (a self-host with no OAuth app set up), both buttons rendered disabled and
  // the single most dangerous screen in the app became a silent dead end. The password
  // step-up form is always available regardless of OAuth config, so that can't happen again.
  it("always offers a password step-up alongside OAuth, so the confirm box is never a dead end", () => {
    expect(pageSource).toContain("copy.reset.passwordCta");
    expect(pageSource).toContain("handlePasswordStepUp");
    expect(pageSource).not.toContain("disabled={!GOOGLE_OAUTH_CLIENT_ID}");
    expect(pageSource).not.toContain("disabled={!GITHUB_OAUTH_CLIENT_ID}");
  });

  it("consumes the in-memory step-up return channel for the proof/token, never sessionStorage", () => {
    expect(pageSource).toContain("takeStepUpReturn");
    expect(codeOnlySource).not.toContain("sessionStorage");
  });

  it("passes the carried refresh token to rotateKeyEpochOAuth as a parameter — no bridge.getRefreshToken()", () => {
    expect(pageSource).toContain("rotateKeyEpochOAuth(bridge, token, refreshToken, protection");
    expect(pageSource).not.toContain("getRefreshToken");
  });

  it("resolves nextUrl and lands via router.replace, not a raw location change", () => {
    expect(pageSource).toContain("router.replace(outcome.nextUrl)");
  });

  it("stashes the provider before redirecting out, reusing beginGoogle/GithubSignIn unchanged", () => {
    expect(pageSource).toContain("stashPendingStepUp({ provider })");
    expect(pageSource).toContain("beginGoogleSignIn()");
    expect(pageSource).toContain("beginGithubSignIn()");
  });
});
