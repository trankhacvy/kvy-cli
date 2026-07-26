"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KeyProtectionChoice } from "@/components/auth/key-protection-choice";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Button } from "@/components/ui/button";
import { type KeyWrapMode, provisionKeyProtection } from "@/crypto";
import { ApiError, register } from "@/lib/api";
import { completeOAuthSignIn } from "@/lib/complete-oauth-sign-in";
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      {status.kind === "working" && (
        <p className="text-sm text-muted-foreground">Finishing sign-in…</p>
      )}

      {status.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">{status.message}</p>
          <Button variant="outline" onClick={() => router.replace("/signin/")}>
            Back to sign in
          </Button>
        </div>
      )}

      {status.kind === "choose-protection" && (
        <KeyProtectionChoice onChoose={(mode) => void handleProtectionChoice(mode)} />
      )}

      {status.kind === "needs-keys" && (
        <RequestKeysPanel onReady={() => router.replace(status.nextUrl)} />
      )}
    </main>
  );
}
