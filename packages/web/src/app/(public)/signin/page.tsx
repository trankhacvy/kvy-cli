"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthArtPanel } from "@/components/auth/auth-art-panel";
import { AuthBrandMark } from "@/components/auth/auth-brand-mark";
import { GithubIcon } from "@/components/icons/github";
import { GoogleIcon } from "@/components/icons/google";
import { Button } from "@/components/ui/button";
import { GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "@/lib/config";
import { copy } from "@/lib/copy";
import { clearTitleOverride, setTitleOverride } from "@/lib/document-title-store";
import { beginGithubSignIn, beginGoogleSignIn } from "@/lib/oauth";
import { peekPendingPair } from "@/lib/pending-pair";
import { isExpiredReason } from "./signin-gate";

// Sign-in / sign-up page (design §5.2, §9.2 "Home" is gated behind this).
// A lost or wiped browser recovers by asking one of the account's other devices for a
// copy of its keys (docs/auth-ux-overhaul-plan.md Phase 4), not by rotating and erasing.
// OAuth here is a straightforward "authenticate with the provider, then the callback page
// sets this browser up" flow, same as email+password at `/password/`.
//
// Layout follows the ui8-brainwave sign-in reference: a narrow, card-less centered
// column (one heading, full-width provider buttons with real brand marks, a plain-text
// divider) beside `AuthArtPanel` — the full-height rounded art panel shared with every
// other unprotected auth screen. Providers whose client id isn't configured are hidden,
// not disabled — an unconfigured provider is an admin setup concern, not an end-user error.

export default function SignInPage() {
  const router = useRouter();
  // docs/auth-ux-hardening-plan.md item 7: `RequireAuth` redirects a failed silent
  // refresh here with `?reason=expired` (`SIGNIN_EXPIRED_PATH`, require-auth.tsx) so
  // this page can explain why the visitor landed on sign-in instead of looking like a
  // bare cold visit. Static export — no server-rendered query string to read on the
  // first paint — so this reads `window.location.search` in an effect rather than
  // `useSearchParams()`, matching the OAuth callback pages' convention
  // (`github/page.tsx`'s `consumeGithubCallback(window.location.search)`).
  const [banner, setBanner] = useState<"expired" | "pair" | null>(null);

  useEffect(() => {
    if (isExpiredReason(window.location.search)) {
      setBanner("expired");
      return;
    }
    if (peekPendingPair()) setBanner("pair");
  }, []);

  // Per-screen tab title (falcon-prd.md FR-7.9), same set-on-mount/clear-on-unmount
  // pattern as `useTabAttention`.
  useEffect(() => {
    setTitleOverride("signin", "Sign in · Falcon");
    return () => clearTitleOverride("signin");
  }, []);

  return (
    <main className="min-h-svh bg-background p-4 sm:p-5">
      <div className="flex min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-2.5rem)]">
        <section className="flex grow items-center justify-center px-6 py-12">
          <div className="w-full max-w-xs">
            {/* Brand mark — on ≥lg it lives on the art panel, so this is mobile's
                only way back home (and its one branding moment). */}
            <AuthBrandMark className="mb-10 justify-center lg:hidden" />

            <div className="text-center">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {banner === "pair" ? copy.signin.titleWithPendingPair : copy.signin.titleDefault}
              </h1>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {banner === "pair"
                  ? copy.signin.subtitleWithPendingPair
                  : copy.signin.subtitleDefault}
              </p>
            </div>

            {/* `aria-live` so the post-hydration banner mount is announced — the
                static export can't render it on first paint. */}
            <div aria-live="polite">
              {banner === "expired" && (
                <div className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-600 dark:text-amber-400">
                  {copy.signin.expiredBanner}
                </div>
              )}
            </div>

            <div className="mt-8 space-y-3">
              {GOOGLE_OAUTH_CLIENT_ID && (
                <Button
                  type="button"
                  size="lg"
                  className="h-11 w-full gap-2.5 border-zinc-200 bg-white text-zinc-900 shadow-xs hover:bg-zinc-100"
                  onClick={() => beginGoogleSignIn()}
                >
                  <GoogleIcon className="size-4.5" />
                  Continue with Google
                </Button>
              )}
              {GITHUB_OAUTH_CLIENT_ID && (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11 w-full gap-2.5"
                  onClick={() => beginGithubSignIn()}
                >
                  <GithubIcon className="size-4.5" />
                  Continue with GitHub
                </Button>
              )}
              {!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && (
                <p className="text-center text-sm text-muted-foreground">
                  {copy.signin.oauthUnavailable}
                </p>
              )}
            </div>

            {/* The divider only earns its place when there's an OAuth button above
                it — with neither configured it dangles between the note and email. */}
            {(GOOGLE_OAUTH_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID) && (
              <p className="my-6 text-center text-sm text-muted-foreground">or</p>
            )}

            <div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 w-full"
                onClick={() => router.push("/password/")}
              >
                {copy.signin.emailCta}
              </Button>
              <p className="mt-2.5 text-center text-xs text-muted-foreground">
                {copy.signin.emailHint}
              </p>
            </div>

            <p className="mt-8 text-center text-sm text-muted-foreground">{copy.signin.footer}</p>
          </div>
        </section>

        <AuthArtPanel caption={copy.signin.panelCaption} />
      </div>
    </main>
  );
}
