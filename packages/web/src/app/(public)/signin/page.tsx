"use client";

import { Fingerprint, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DEV_AUTH_ENABLED, GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "@/lib/config";
import { beginGithubSignIn, beginGoogleSignIn } from "@/lib/oauth";
import { isExpiredReason } from "./signin-gate";

// Sign-in / sign-up page (design §5.2, §9.2 "Home" is gated behind this).
// issue-4-plan.md §5.5/Phase 4: the legacy "trusted-device silently signs in via a
// self-issued challenge" path (`POST /v1/auth`) and the recovery-code restore flow
// are both gone — a lost/wiped browser now recovers via `keys/bind`'s rotate-epoch
// flow (see `/password/`'s "Forgot your PIN?" / "no key material" steps) instead of
// a client-trusted code. OAuth here is a straightforward "authenticate with the
// provider, then the callback page binds this device's key material" flow, same as
// email+password at `/password/`.
export default function SignInPage() {
  const router = useRouter();
  // docs/auth-ux-hardening-plan.md item 7: `RequireAuth` redirects a failed silent
  // refresh here with `?reason=expired` (`SIGNIN_EXPIRED_PATH`, require-auth.tsx) so
  // this page can explain why the visitor landed on sign-in instead of looking like a
  // bare cold visit. Static export — no server-rendered query string to read on the
  // first paint — so this reads `window.location.search` in an effect rather than
  // `useSearchParams()`, matching the OAuth callback pages' convention
  // (`github/page.tsx`'s `consumeGithubCallback(window.location.search)`).
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    setExpired(isExpiredReason(window.location.search));
  }, []);

  return (
    <main className="min-h-screen bg-background">
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)]">
        <section className="flex items-center justify-center px-6 py-10 sm:px-8 lg:px-12">
          <div className="w-full max-w-md space-y-8">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                Falcon
              </div>
              <div className="space-y-3">
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                  Sign in to your secure workspace
                </h1>
                <p className="text-sm leading-6 text-muted-foreground sm:text-base">
                  End-to-end encrypted mission control for coding agents, designed for trusted
                  devices and deliberate access recovery.
                </p>
              </div>
            </div>

            {expired && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                Your session expired — sign in again to continue.
              </div>
            )}

            <Card className="border border-border/60 bg-card/95 shadow-sm backdrop-blur">
              <CardHeader className="space-y-2">
                <CardTitle>Continue to Falcon</CardTitle>
                <CardDescription>
                  {DEV_AUTH_ENABLED
                    ? "Sign in with a provider, or use email + password instead."
                    : "Sign in with a provider."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <Button
                    type="button"
                    size="lg"
                    className="w-full justify-between"
                    disabled={!GOOGLE_OAUTH_CLIENT_ID}
                    onClick={() => beginGoogleSignIn()}
                  >
                    <span className="flex items-center gap-2">
                      <ShieldCheck className="size-4" aria-hidden="true" />
                      Continue with Google
                    </span>
                    <Sparkles className="size-4 opacity-70" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="lg"
                    variant="secondary"
                    className="w-full justify-between"
                    disabled={!GITHUB_OAUTH_CLIENT_ID}
                    onClick={() => beginGithubSignIn()}
                  >
                    <span className="flex items-center gap-2">
                      <Fingerprint className="size-4" aria-hidden="true" />
                      Continue with GitHub
                    </span>
                    <KeyRound className="size-4 opacity-70" aria-hidden="true" />
                  </Button>
                  {!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && !DEV_AUTH_ENABLED && (
                    <p className="text-xs text-muted-foreground">
                      No OAuth provider is configured for this deployment.
                    </p>
                  )}
                </div>

                {DEV_AUTH_ENABLED && (
                  <>
                    <div className="relative">
                      <Separator />
                      <span className="absolute inset-x-0 -top-2 mx-auto w-fit bg-card px-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                        Or
                      </span>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
                      <p className="text-sm leading-6 text-muted-foreground">
                        Prefer email + password? That flow also sets up (or unlocks) this browser's
                        encrypted key material with a PIN. (Local testing only.)
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => router.push("/password/")}
                      >
                        Continue with email + password
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => router.push("/auth/callback/dev/")}
                      >
                        Continue without OAuth (dev only)
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <p className="text-center text-sm leading-6 text-muted-foreground">
              {DEV_AUTH_ENABLED
                ? "OAuth and email+password are both first-class login identities — either one provisions this browser's key material the first time it's used here."
                : "Signing in provisions this browser's key material the first time it's used here."}
            </p>
          </div>
        </section>

        <aside className="hidden border-l border-border/60 bg-muted/20 lg:flex">
          <div className="flex w-full items-center justify-center p-8 xl:p-12">
            <div className="relative h-[min(78vh,860px)] w-full overflow-hidden rounded-[32px] border border-border/60 bg-card shadow-sm">
              <img
                src="https://coresg-normal.trae.ai/api/ide/v1/text_to_image?prompt=cinematic%20futuristic%20mission%20control%20workspace%2C%20encrypted%20agent%20operations%20dashboard%2C%20glowing%20glass%20panels%2C%20soft%20atmospheric%20lighting%2C%20sleek%20hardware%20desk%20setup%2C%20high-end%20product%20illustration%2C%20clean%20composition%2C%20premium%20editorial%20style&image_size=portrait_4_3"
                alt=""
                aria-hidden="true"
                className="size-full object-cover"
              />
              <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background/10 via-transparent to-background/5" />
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
