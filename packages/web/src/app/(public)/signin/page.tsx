"use client";

import { Fingerprint, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RecoveryCodeInput } from "@/components/auth/recovery-code-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { completeChallengeSignIn } from "@/lib/complete-challenge-sign-in";
import { DEV_AUTH_ENABLED, GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "@/lib/config";
import { beginGithubSignIn, beginGoogleSignIn } from "@/lib/oauth";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { handleRestoreFromRecoveryCode, type RestoreStatus } from "./restore-handler";

type Status =
  | { kind: "checking" }
  | { kind: "signing-in" }
  | { kind: "needs-signup" }
  | { kind: "error"; message: string };

// Sign-in / sign-up page (design §5.2, §9.2 "Home" is gated behind this).
// A returning device (this browser already holds a provisioned identity)
// signs in silently via a signed challenge — no OAuth round trip needed. A
// new device shows OAuth buttons; the callback pages
// (`src/app/auth/callback/{google,github}`) do the actual key generation +
// `POST /v1/auth/register`.
export default function SignInPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<Status>({ kind: "checking" });
  // Bumped by the error state's "Try again" button to re-run the identity
  // check / challenge sign-in below without a full page reload.
  const [attempt, setAttempt] = useState(0);
  // Independent of `status` on purpose (see restore-handler.ts's docblock):
  // a restore attempt must not unmount needs-signup's OAuth buttons or the
  // recovery-code input while it's in flight or if it fails.
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>({ kind: "idle" });

  function handleRestoreSubmit(code: string) {
    if (!bridge) return;
    handleRestoreFromRecoveryCode(bridge, code, {
      setRestoreStatus,
      onSuccess: (nextUrl) => router.replace(nextUrl),
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is intentionally over-specified to re-trigger this effect from the "Try again" button
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    setStatus({ kind: "checking" });

    (async () => {
      const identity = await bridge.getIdentity();
      if (cancelled) return;

      if (!identity) {
        setStatus({ kind: "needs-signup" });
        return;
      }

      setStatus({ kind: "signing-in" });
      try {
        const { nextUrl } = await completeChallengeSignIn(bridge);
        if (!cancelled) router.replace(nextUrl);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : "Sign-in failed. Please retry.";
        setStatus({ kind: "error", message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, router, attempt]);

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

            <Card className="border border-border/60 bg-card/95 shadow-sm backdrop-blur">
              <CardHeader className="space-y-2">
                <CardTitle>Continue to Falcon</CardTitle>
                <CardDescription>
                  Returning devices sign in automatically. New browsers are provisioned through your
                  selected provider.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {(status.kind === "checking" || status.kind === "signing-in") && (
                  <>
                    <div
                      className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/30 p-4"
                      aria-live="polite"
                    >
                      <div className="mt-0.5 rounded-full border border-border/70 bg-background p-2">
                        <Spinner className="size-4" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">
                          {status.kind === "signing-in"
                            ? "Finishing your sign-in"
                            : "Checking this device"}
                        </p>
                        <p className="text-sm leading-6 text-muted-foreground">
                          {status.kind === "signing-in"
                            ? "Your encrypted identity is being verified and the next workspace is loading."
                            : "If this browser already holds a provisioned identity, Falcon signs you in without an OAuth round trip."}
                        </p>
                      </div>
                    </div>

                    <div className="relative">
                      <Separator />
                      <span className="absolute inset-x-0 -top-2 mx-auto w-fit bg-card px-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                        Secure flow
                      </span>
                    </div>

                    <div className="rounded-xl border border-border/70 bg-background p-4">
                      <div className="flex items-start gap-3">
                        <div className="rounded-full border border-border/70 bg-muted/30 p-2">
                          <Fingerprint
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Trusted-device sign-in</p>
                          <p className="text-sm leading-6 text-muted-foreground">
                            This page keeps the original device-check flow intact, then hands
                            control to the challenge sign-in path when an identity is available.
                          </p>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {status.kind === "error" && (
                  <>
                    <div
                      className="space-y-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
                      aria-live="polite"
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-destructive">
                          We could not finish your sign-in
                        </p>
                        <p className="text-sm leading-6 text-destructive/90">{status.message}</p>
                      </div>
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => setAttempt((n) => n + 1)}
                      >
                        Try again
                      </Button>
                    </div>

                    <div className="relative">
                      <Separator />
                      <span className="absolute inset-x-0 -top-2 mx-auto w-fit bg-card px-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                        Recovery
                      </span>
                    </div>

                    <p className="text-sm leading-6 text-muted-foreground">
                      Retry re-runs the same device-check flow without changing any auth callbacks
                      or route behavior.
                    </p>
                  </>
                )}

                {status.kind === "needs-signup" && (
                  <>
                    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Already have a Falcon account?</p>
                        <p className="text-sm leading-6 text-muted-foreground">
                          Restore your original identity on this browser using a recovery code you
                          exported earlier.
                        </p>
                      </div>
                      <RecoveryCodeInput
                        onSubmit={handleRestoreSubmit}
                        pending={restoreStatus.kind === "restoring"}
                      />
                      {restoreStatus.kind === "error" && (
                        <p
                          className="text-sm leading-6 text-destructive"
                          aria-live="polite"
                          data-testid="restore-error"
                        >
                          {restoreStatus.message}
                        </p>
                      )}
                    </div>

                    <div className="relative">
                      <Separator />
                      <span className="absolute inset-x-0 -top-2 mx-auto w-fit bg-card px-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                        Or provision this browser
                      </span>
                    </div>

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
                    </div>

                    <div className="relative">
                      <Separator />
                      <span className="absolute inset-x-0 -top-2 mx-auto w-fit bg-card px-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                        Browser setup
                      </span>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
                      <p className="text-sm leading-6 text-muted-foreground">
                        The callback pages generate device keys and finish registration for this
                        browser without changing the existing sign-in logic.
                      </p>
                      {!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && !DEV_AUTH_ENABLED && (
                        <p className="text-xs text-muted-foreground">
                          No OAuth provider is configured for this deployment.
                        </p>
                      )}
                      {DEV_AUTH_ENABLED && (
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full"
                          onClick={() => router.push("/auth/callback/dev/")}
                        >
                          Continue without OAuth (dev only)
                        </Button>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <p className="text-center text-sm leading-6 text-muted-foreground">
              OAuth is only used to provision a new browser. Trusted devices return through the
              signed challenge flow automatically.
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
