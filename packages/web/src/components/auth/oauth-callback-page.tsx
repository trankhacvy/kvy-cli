"use client";

import { AlertTriangle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthArtPanel } from "@/components/auth/auth-art-panel";
import { AuthBrandMark } from "@/components/auth/auth-brand-mark";
import { KeyProtectionChoice } from "@/components/auth/key-protection-choice";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type KeyWrapMode, provisionKeyProtection } from "@/crypto";
import { ApiError, register } from "@/lib/api";
import { completeOAuthSignIn } from "@/lib/complete-oauth-sign-in";
import { copy } from "@/lib/copy";
import { clearTitleOverride, setTitleOverride } from "@/lib/document-title-store";
import { consumePendingStepUp, setStepUpReturn } from "@/lib/pending-stepup";
import { getAccountId, setToken } from "@/lib/session";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";

type Status =
  | { kind: "working" }
  | { kind: "error"; message: string }
  | { kind: "choose-protection"; oauthProof: string }
  /** This account's keys are already bound on another device — offer to fetch them here. */
  | { kind: "needs-keys"; nextUrl: string };

/**
 * Shared body for `/auth/callback/google` and `/auth/callback/github` — everything from
 * here on (identity generation, `POST /v1/auth/register`, key custody, the pending-pair
 * redirect) is provider-agnostic; only how `oauthProof` was obtained differs.
 *
 * docs/auth-ux-overhaul-plan.md Phase 5: no PIN. A genuinely new browser picks how it
 * protects keys at rest; a returning one loads them with no interaction at all.
 */
function decodeAccountLabel(): string {
  return getAccountId() ?? "Falcon";
}

export function OAuthCallbackPage({
  provider,
  resolveProof,
}: {
  provider: "google" | "github";
  resolveProof: () => Promise<{ ok: true; value: string } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<Status>({ kind: "working" });

  useEffect(() => {
    setTitleOverride("oauth-callback", "Signing in · Falcon");
    return () => clearTitleOverride("oauth-callback");
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveProof is stable per page mount (constructed from the immutable initial URL); including it would refire this effect on every render
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    (async () => {
      const proof = await resolveProof();
      if (cancelled) return;
      if (!proof.ok) {
        setStatus({ kind: "error", message: proof.error });
        return;
      }

      // `/reset-keys/` stashed a step-up flag before sending the browser out to this
      // provider. `consume` (one-shot) + provider match closes the confused-deputy hole:
      // an abandoned Google step-up can't divert a later GitHub sign-in in the same tab.
      const stepUpProvider = consumePendingStepUp(provider);
      if (stepUpProvider) {
        try {
          const { token, refreshToken } = await register({
            oauthProvider: provider,
            oauthProof: proof.value,
          });
          if (cancelled) return;
          setToken(token);
          setStepUpReturn({ provider, oauthProof: proof.value, refreshToken });
          router.replace("/reset-keys/");
        } catch (err) {
          if (cancelled) return;
          setStatus({
            kind: "error",
            message: err instanceof ApiError ? err.message : "Sign-in failed. Please try again.",
          });
        }
        return;
      }

      // Unscoped on purpose: this runs BEFORE `register()` mints an access token (that
      // happens inside `completeOAuthSignIn` below, or in the step-up branch above), so
      // there is no account id available yet to scope by. It is honestly just a cheap "does
      // this browser have any keys at all" pre-check — `completeOAuthSignIn`'s own
      // `getIdentity(accountId)` call is the authoritative, account-scoped one.
      const identity = await bridge.getIdentity();
      if (cancelled) return;
      if (!identity) {
        setStatus({ kind: "choose-protection", oauthProof: proof.value });
        return;
      }

      try {
        // A returning browser reuses its stored identity, so `completeOAuthSignIn` never
        // consults this — no passkey prompt on a plain sign-in.
        const outcome = await completeOAuthSignIn(bridge, provider, proof.value, {
          mode: "device",
        });
        if (cancelled) return;
        if (outcome.kind === "existing-identity") {
          await bridge.setRefreshToken(outcome.refreshToken);
        }
        router.replace(outcome.nextUrl);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 409) {
          // The account's keys are bound on another device — this browser can't first-bind.
          // Fetching them is the non-destructive answer, same as `handleProtectionChoice`.
          setStatus({ kind: "needs-keys", nextUrl: "/dashboard/" });
          return;
        }
        setStatus({
          kind: "error",
          message: err instanceof ApiError ? err.message : "Sign-in failed. Please try again.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, provider, router]);

  async function handleProtectionChoice(mode: KeyWrapMode): Promise<void> {
    if (!bridge || status.kind !== "choose-protection") return;
    const { oauthProof } = status;
    setStatus({ kind: "working" });
    try {
      const protection = await provisionKeyProtection(mode, decodeAccountLabel());
      const outcome = await completeOAuthSignIn(bridge, provider, oauthProof, protection);
      router.replace(outcome.nextUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The account already has keys bound elsewhere, so this browser can't first-bind.
        // Fetching them from that device is the non-destructive answer.
        setStatus({ kind: "needs-keys", nextUrl: "/dashboard/" });
        return;
      }
      setStatus({
        kind: "error",
        message: err instanceof ApiError ? err.message : "Sign-in failed. Please try again.",
      });
    }
  }

  return (
    <main className="min-h-svh bg-background p-4 sm:p-5">
      <div className="flex min-h-[calc(100svh-2rem)] sm:min-h-[calc(100svh-2.5rem)]">
        <section className="flex grow items-center justify-center px-6 py-12">
          <div className="w-full max-w-sm">
            <AuthBrandMark className="mb-10 justify-center lg:hidden" />

            {status.kind === "working" && (
              <div
                className="flex flex-col items-center gap-3 py-6 text-center"
                aria-live="polite"
              >
                <Spinner className="size-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{copy.oauthCallback.working}</p>
              </div>
            )}

            {status.kind === "error" && (
              <div className="flex flex-col items-center gap-4 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
                </span>
                <div className="space-y-2">
                  <h1 className="font-semibold text-2xl tracking-tight">
                    {copy.oauthCallback.errorTitle}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground" aria-live="polite">
                    {status.message}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() => router.replace("/signin/")}
                >
                  {copy.oauthCallback.backToSigninCta}
                </Button>
              </div>
            )}

            {status.kind === "choose-protection" && (
              <KeyProtectionChoice onChoose={(mode) => void handleProtectionChoice(mode)} />
            )}

            {status.kind === "needs-keys" && (
              <RequestKeysPanel onReady={() => router.replace(status.nextUrl)} />
            )}
          </div>
        </section>

        <AuthArtPanel caption={copy.signin.panelCaption} />
      </div>
    </main>
  );
}
