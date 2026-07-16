"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { completeChallengeSignIn } from "@/lib/complete-challenge-sign-in";
import { GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "@/lib/config";
import { beginGithubSignIn, beginGoogleSignIn } from "@/lib/oauth";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

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
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Falcon</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          End-to-end encrypted mission control for coding agents.
        </p>
      </div>

      {(status.kind === "checking" || status.kind === "signing-in") && (
        <p className="text-sm text-muted-foreground">
          {status.kind === "signing-in" ? "Signing you in…" : "Checking this device…"}
        </p>
      )}

      {status.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-3">
          <p className="text-sm text-destructive">{status.message}</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      )}

      {status.kind === "needs-signup" && (
        <div className="flex w-full max-w-xs flex-col gap-3">
          <Button
            type="button"
            disabled={!GOOGLE_OAUTH_CLIENT_ID}
            onClick={() => beginGoogleSignIn()}
          >
            Continue with Google
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!GITHUB_OAUTH_CLIENT_ID}
            onClick={() => beginGithubSignIn()}
          >
            Continue with GitHub
          </Button>
          {!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && (
            <p className="text-xs text-muted-foreground">
              No OAuth provider is configured for this deployment.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
