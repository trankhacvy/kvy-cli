"use client";

import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthArtPanel } from "@/components/auth/auth-art-panel";
import { AuthBrandMark } from "@/components/auth/auth-brand-mark";
import { KeyProtectionChoice } from "@/components/auth/key-protection-choice";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { type KeyWrapMode, provisionKeyProtection } from "@/crypto";
import { ApiError, passwordLogin, revokeOtherSessions } from "@/lib/api";
import { rotateKeyEpoch, rotateKeyEpochOAuth } from "@/lib/complete-password-sign-in";
import { GITHUB_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_ID } from "@/lib/config";
import { copy } from "@/lib/copy";
import { clearTitleOverride, setTitleOverride } from "@/lib/document-title-store";
import { beginGithubSignIn, beginGoogleSignIn } from "@/lib/oauth";
import { type StepUpProvider, stashPendingStepUp, takeStepUpReturn } from "@/lib/pending-stepup";
import { derivePhaseFromReturn, type ResetKeysPhase as Phase } from "@/lib/reset-keys-phase";
import { getToken, setToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

/**
 * docs/auth-ux-hardening-plan.md item 2/4: provider-agnostic "reset keys" recovery,
 * reachable from `StartOverLink` (offered wherever a browser has no usable key material)
 * and the OAuth callback's step-up-return continuation (`oauth-callback-page.tsx`'s
 * `consumePendingStepUp` branch).
 *
 * This is post-login recovery, so it consumes the in-memory return payload the OAuth callback
 * left behind (`takeStepUpReturn()`) — a fresh access token is already set by the callback's
 * completed `register()` + `setToken()`, and the refresh token + resolved proof ride along in
 * memory (never `sessionStorage` — security review finding F1). The password step-up form
 * below does the equivalent re-authentication inline, via `passwordLogin`, without a redirect.
 *
 * Uses the raw `useCryptoBridge()` client, NOT `useUnlockedCryptoBridge()`: the latter only
 * exposes a `bridge` binding once its own status reaches `"ready"`, but this page needs to call
 * `bridge.init(...)` from exactly the states `useUnlocked…` calls `"no-identity"` and
 * `"needs-unlock"` — where it carries no `bridge` at all. So the only guard this page needs is
 * `if (!bridge) return` (the worker hasn't mounted yet); it never branches on an unlock-status
 * kind, which is what makes it reachable from both entry states identically.
 *
 * Layout shares `/signin`'s shell (`AuthArtPanel`, `AuthBrandMark`) — this is arguably the
 * highest-stakes screen in the app (it can permanently archive a user's encrypted sessions),
 * so it's the last place that should look unbranded.
 */
export default function ResetKeysPage() {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm-identity" });
  const [confirmingReset, setConfirmingReset] = useState(false);
  /** The last bind attempt, re-invoked by "Log out all other devices" once that call
   *  succeeds — a ref (not state) since it's never rendered, just re-called; a plain
   *  closure over `handleProtectionChoice`'s own `token`/`protection`/`phase` so retrying
   *  doesn't redo `provisionKeyProtection` (which can be an interactive passkey ceremony
   *  for "prf" mode) or regenerate the master secret a second time. */
  const retryBindRef = useRef<(() => Promise<void>) | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  // The password step-up form's own local state — a lighter-weight sibling of `/password/`'s
  // sign-in form, scoped to just proving the current password before rotating keys.
  const [passwordFormOpen, setPasswordFormOpen] = useState(false);
  const [stepUpEmail, setStepUpEmail] = useState("");
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpPending, setStepUpPending] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  useEffect(() => {
    setPhase(derivePhaseFromReturn(takeStepUpReturn()));
  }, []);

  useEffect(() => {
    setTitleOverride("reset-keys", "Reset your keys · Falcon");
    return () => clearTitleOverride("reset-keys");
  }, []);

  function beginStepUp(provider: StepUpProvider): void {
    stashPendingStepUp({ provider });
    if (provider === "google") beginGoogleSignIn();
    else beginGithubSignIn();
  }

  async function handlePasswordStepUp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStepUpError(null);
    setStepUpPending(true);
    try {
      const { token, refreshToken } = await passwordLogin({
        email: stepUpEmail,
        password: stepUpPassword,
      });
      setToken(token);
      setPhase({ kind: "returned", method: "password", refreshToken, stepUpPassword });
    } catch (err) {
      setStepUpError(err instanceof ApiError ? err.message : copy.reset.passwordError);
      setStepUpPending(false);
    }
  }

  async function handleProtectionChoice(mode: KeyWrapMode): Promise<void> {
    if (!bridge) return;
    if (phase.kind !== "returned") return;
    const returnedPhase = phase;
    const token = getToken();
    if (!token) {
      setPhase({ kind: "error", message: copy.reset.signedOutMidFlow });
      return;
    }
    const protection = await provisionKeyProtection(mode, "Falcon");

    async function attempt(): Promise<void> {
      // Both re-checked here (already guaranteed non-null by the outer early-returns above)
      // so this nested closure's own control-flow narrowing applies to `bridge`/`token`.
      if (!bridge || !token) return;
      setPhase({ kind: "rotating" });

      if (returnedPhase.method === "oauth") {
        const { provider, oauthProof, refreshToken } = returnedPhase;
        const outcome = await rotateKeyEpochOAuth(bridge, token, refreshToken, protection, {
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
        if (outcome.kind === "other-devices-online") {
          setPhase({ kind: "rotating", error: outcome.message, otherDevicesOnline: true });
          return;
        }
        setPhase({ kind: "rotating", error: outcome.message });
        return;
      }

      const { refreshToken, stepUpPassword: proofPassword } = returnedPhase;
      const outcome = await rotateKeyEpoch(bridge, token, refreshToken, proofPassword, protection);
      if (outcome.kind === "ok") {
        router.replace(outcome.nextUrl);
        return;
      }
      if (outcome.kind === "other-devices-online") {
        setPhase({ kind: "rotating", error: outcome.message, otherDevicesOnline: true });
        return;
      }
      setPhase({ kind: "rotating", error: outcome.message });
    }

    retryBindRef.current = attempt;
    await attempt();
  }

  /** The 409's self-serve way out: the endpoint only requires being logged in, not having
   *  keys (`sessionsAdmin.ts`'s `revoke-others` — identity-gated, same as this whole page),
   *  so it's reachable from exactly the keyless state this page runs in. */
  async function handleLogOutOthersAndRetry(): Promise<void> {
    const token = getToken();
    if (!token || !retryBindRef.current) return;
    setRevokingOthers(true);
    try {
      await revokeOtherSessions(token);
      await retryBindRef.current();
    } catch (err) {
      setPhase({
        kind: "rotating",
        error: err instanceof ApiError ? err.message : "Couldn't log out other devices. Retry.",
        otherDevicesOnline: true,
      });
    } finally {
      setRevokingOthers(false);
    }
  }

  return (
    <main className="min-h-svh bg-background p-4 sm:p-5">
      <div className="flex min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-2.5rem)]">
        <section className="flex grow items-center justify-center px-6 py-12">
          <div className="w-full max-w-sm">
            <AuthBrandMark className="mb-10 justify-center lg:hidden" />

            {phase.kind === "confirm-identity" && (
              <div className="flex flex-col gap-6">
                <div className="space-y-3">
                  <h1 className="font-semibold text-2xl tracking-tight">{copy.reset.pageTitle}</h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {copy.reset.pageSubtitle}
                  </p>
                </div>

                <Button
                  type="button"
                  size="lg"
                  className="h-11"
                  onClick={() => setPhase({ kind: "fetch-keys" })}
                >
                  {copy.reset.fetchKeysCta}
                </Button>

                <Separator />

                {!confirmingReset ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-11 text-destructive"
                    onClick={() => setConfirmingReset(true)}
                  >
                    {copy.reset.resetInsteadCta}
                  </Button>
                ) : (
                  <div className="space-y-4 rounded-xl border border-destructive/40 p-4">
                    <div className="space-y-1.5">
                      <p className="font-medium text-destructive text-sm">
                        {copy.reset.confirmHeading}
                      </p>
                      <p className="text-muted-foreground text-sm">{copy.reset.confirmBody}</p>
                    </div>

                    {(GOOGLE_OAUTH_CLIENT_ID || GITHUB_OAUTH_CLIENT_ID) && (
                      <div className="flex flex-col gap-2">
                        {GOOGLE_OAUTH_CLIENT_ID && (
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => beginStepUp("google")}
                          >
                            Confirm with Google
                          </Button>
                        )}
                        {GITHUB_OAUTH_CLIENT_ID && (
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => beginStepUp("github")}
                          >
                            Confirm with GitHub
                          </Button>
                        )}
                      </div>
                    )}

                    {!GOOGLE_OAUTH_CLIENT_ID && !GITHUB_OAUTH_CLIENT_ID && (
                      <p className="text-muted-foreground text-xs">{copy.reset.oauthUnavailable}</p>
                    )}

                    {!passwordFormOpen ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setPasswordFormOpen(true)}
                      >
                        {copy.reset.passwordCta}
                      </Button>
                    ) : (
                      <form className="space-y-3" onSubmit={handlePasswordStepUp}>
                        <div className="space-y-1.5">
                          <label htmlFor="stepup-email" className="font-medium text-xs">
                            Email
                          </label>
                          <Input
                            id="stepup-email"
                            type="email"
                            autoComplete="email"
                            required
                            value={stepUpEmail}
                            onChange={(event) => setStepUpEmail(event.target.value)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor="stepup-password" className="font-medium text-xs">
                            Password
                          </label>
                          <Input
                            id="stepup-password"
                            type="password"
                            autoComplete="current-password"
                            required
                            value={stepUpPassword}
                            onChange={(event) => setStepUpPassword(event.target.value)}
                          />
                        </div>
                        {stepUpError && (
                          <p className="text-destructive text-sm" aria-live="polite">
                            {stepUpError}
                          </p>
                        )}
                        <Button
                          type="submit"
                          variant="destructive"
                          className="w-full"
                          disabled={stepUpPending}
                        >
                          {stepUpPending ? "Please wait…" : copy.reset.passwordSubmitCta}
                        </Button>
                        <p className="text-center text-muted-foreground text-xs">
                          {copy.reset.passwordHint}
                        </p>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}

            {phase.kind === "fetch-keys" && (
              <RequestKeysPanel onReady={() => router.replace("/dashboard/")} />
            )}

            {phase.kind === "returned" && (
              <KeyProtectionChoice onChoose={(mode) => void handleProtectionChoice(mode)} />
            )}

            {phase.kind === "rotating" && !phase.error && (
              <div className="flex flex-col items-center gap-3 py-6 text-center" aria-live="polite">
                <Spinner className="size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{copy.reset.rotating}</p>
              </div>
            )}

            {phase.kind === "rotating" && phase.error && (
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                </span>
                <div className="space-y-2">
                  <h1 className="font-semibold text-2xl tracking-tight">
                    {copy.reset.rotatingErrorTitle}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground" aria-live="polite">
                    {phase.error}
                  </p>
                </div>
                {phase.otherDevicesOnline ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="lg"
                    className="h-11"
                    disabled={revokingOthers}
                    onClick={() => void handleLogOutOthersAndRetry()}
                  >
                    {revokingOthers ? "Please wait…" : copy.reset.otherDevicesCta}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-11"
                    onClick={() => setPhase({ kind: "confirm-identity" })}
                  >
                    {copy.reset.retryCta}
                  </Button>
                )}
              </div>
            )}

            {phase.kind === "error" && (
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                </span>
                <div className="space-y-2">
                  <h1 className="font-semibold text-2xl tracking-tight">
                    {copy.reset.signedOutTitle}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">{phase.message}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() => router.replace("/signin/")}
                >
                  {copy.reset.backToSigninCta}
                </Button>
              </div>
            )}
          </div>
        </section>

        <AuthArtPanel caption={copy.signin.panelCaption} />
      </div>
    </main>
  );
}
