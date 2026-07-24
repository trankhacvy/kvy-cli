"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PinSetupForm } from "@/components/auth/pin-setup-form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { rotateKeyEpochOAuth } from "@/lib/complete-password-sign-in";
import { GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "@/lib/config";
import { beginGithubSignIn, beginGoogleSignIn } from "@/lib/oauth";
import { type StepUpProvider, stashPendingStepUp, takeStepUpReturn } from "@/lib/pending-stepup";
import { derivePhaseFromReturn, type ResetKeysPhase as Phase } from "@/lib/reset-keys-phase";
import { getToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

/**
 * docs/auth-ux-hardening-plan.md item 2/4: provider-agnostic "reset keys" recovery, reachable
 * from `RequireAuth`'s `no-identity` dead-end, `PinUnlockForm`'s "Forgot your PIN?" link
 * (`needs-unlock`), and the OAuth callback's returning-user 409 branch.
 *
 * This is post-login recovery, so it consumes the in-memory return payload the OAuth callback
 * left behind (`takeStepUpReturn()`) — a fresh access token is already set by the callback's
 * completed `register()` + `setToken()`, and the refresh token + resolved proof ride along in
 * memory (never `sessionStorage` — security review finding F1).
 *
 * Uses the raw `useCryptoBridge()` client, NOT `useUnlockedCryptoBridge()`: the latter only
 * exposes a `bridge` binding once its own status reaches `"ready"`, but this page needs to call
 * `bridge.init(...)` from exactly the states `useUnlocked…` calls `"no-identity"` and
 * `"needs-unlock"` — where it carries no `bridge` at all. So the only guard this page needs is
 * `if (!bridge) return` (the worker hasn't mounted yet); it never branches on an unlock-status
 * kind, which is what makes it reachable from both entry states identically.
 */
export default function ResetKeysPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm-identity" });
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    setPhase(derivePhaseFromReturn(takeStepUpReturn()));
  }, []);

  function beginStepUp(provider: StepUpProvider): void {
    stashPendingStepUp({ provider });
    if (provider === "google") beginGoogleSignIn();
    else beginGithubSignIn();
  }

  async function handleNewPin(pin: string): Promise<void> {
    if (!bridge) return;
    if (phase.kind !== "returned") return;
    const token = getToken();
    if (!token) {
      setPhase({ kind: "error", message: "You've been signed out. Please start over." });
      return;
    }
    const { provider, oauthProof, refreshToken } = phase;
    setPhase({ kind: "rotating" });
    const outcome = await rotateKeyEpochOAuth(bridge, token, refreshToken, pin, {
      provider,
      oauthProof,
    });
    if (outcome.kind === "ok") {
      router.replace(outcome.nextUrl);
      return;
    }
    if (outcome.kind === "identity-mismatch") {
      setPhase({ kind: "confirm-identity" }); // wrong account at the provider — re-prove
      return;
    }
    setPhase({ kind: "rotating", error: outcome.message }); // 409 / other
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      {phase.kind === "confirm-identity" && (
        <div className="flex w-full max-w-sm flex-col gap-6">
          <div className="space-y-3">
            <h1 className="text-2xl font-semibold tracking-tight">Recover this browser</h1>
            <p className="text-sm text-muted-foreground">
              The safest option keeps all your encrypted sessions. Resetting keys signs every
              other device out and archives data encrypted under the old keys.
            </p>
          </div>

          <Button type="button" size="lg" onClick={() => router.push("/pair/")}>
            Pair from another device
          </Button>

          <Separator />

          {!confirmingReset ? (
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmingReset(true)}
            >
              Reset keys instead
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-destructive/40 p-4">
              <p className="text-sm text-destructive">
                This permanently archives everything encrypted under your current keys and logs
                out every other device. Confirm it's you to continue.
              </p>
              <div className="flex flex-col gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!GOOGLE_OAUTH_CLIENT_ID}
                  onClick={() => beginStepUp("google")}
                >
                  Confirm with Google
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={!GITHUB_OAUTH_CLIENT_ID}
                  onClick={() => beginStepUp("github")}
                >
                  Confirm with GitHub
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase.kind === "returned" && (
        <div className="w-full max-w-sm">
          <PinSetupForm onSubmit={handleNewPin} />
        </div>
      )}

      {phase.kind === "rotating" && !phase.error && (
        <p className="text-sm text-muted-foreground">Rotating your keys…</p>
      )}

      {phase.kind === "rotating" && phase.error && (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive" aria-live="polite">
            {phase.error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPhase({ kind: "confirm-identity" })}
          >
            Try again
          </Button>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">{phase.message}</p>
          <Button type="button" variant="outline" onClick={() => router.replace("/signin/")}>
            Back to sign in
          </Button>
        </div>
      )}
    </main>
  );
}
