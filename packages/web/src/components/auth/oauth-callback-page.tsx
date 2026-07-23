"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PinSetupForm } from "@/components/auth/pin-setup-form";
import { PinUnlockForm } from "@/components/auth/pin-unlock-form";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { completeOAuthSignIn } from "@/lib/complete-oauth-sign-in";
import {
  isCryptoBridgeUnlocked,
  markCryptoBridgeUnlocked,
  useCryptoBridge,
} from "@/lib/use-crypto-bridge";

type Status =
  | { kind: "working" }
  | { kind: "error"; message: string }
  | { kind: "set-pin"; oauthProof: string }
  // Security review finding F1: the "unlock" step is only ever reached via the
  // existing-identity branch below (a brand-new identity is provisioned — and its
  // refresh token PIN-wrapped — directly inside `completeOAuthSignIn`'s `init` call, so
  // it never needs this step at all). `refreshToken` is held here only transiently, to
  // hand to `bridge.setRefreshToken` once `handleUnlock` confirms the worker is
  // unlocked — never written to `localStorage` or any other persistent store.
  | { kind: "unlock"; nextUrl: string; refreshToken: string; error?: string };

/**
 * Shared body for both `/auth/callback/google` and `/auth/callback/github`
 * — everything from here on (identity generation, `POST /v1/auth/register`,
 * PIN key custody, the pending-pair redirect) is provider-agnostic; only
 * how the `oauthProof` was obtained differs between the two pages.
 *
 * issue-4-plan.md §6.1: a genuinely new identity needs a PIN before
 * `completeOAuthSignIn` can wrap it (`set-pin` step, below); a returning device
 * whose crypto worker isn't unlocked yet needs its PIN too (`unlock` step) — both are
 * resolved before this page ever redirects onward.
 */
export function OAuthCallbackPage({
  provider,
  resolveProof,
}: {
  provider: "google" | "github" | "dev";
  /** Resolves the `oauthProof` string this provider's redirect handed back, or throws/returns an error message. */
  resolveProof: () => Promise<{ ok: true; value: string } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const bridge = useCryptoBridge();
  const [status, setStatus] = useState<Status>({ kind: "working" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveProof is stable per page mount (constructed fresh by the caller from the immutable initial URL), including it would refire this effect on every render for no reason
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

      const identity = await bridge.getIdentity();
      if (cancelled) return;
      if (!identity) {
        // New browser: need a PIN before `completeOAuthSignIn` can provision it.
        setStatus({ kind: "set-pin", oauthProof: proof.value });
        return;
      }

      try {
        const outcome = await completeOAuthSignIn(bridge, provider, proof.value, "");
        if (cancelled) return;
        if (isCryptoBridgeUnlocked()) {
          if (outcome.kind === "existing-identity") {
            await bridge.setRefreshToken(outcome.refreshToken);
          }
          router.replace(outcome.nextUrl);
        } else if (outcome.kind === "existing-identity") {
          setStatus({ kind: "unlock", nextUrl: outcome.nextUrl, refreshToken: outcome.refreshToken });
        } else {
          // Unreachable in practice: a brand-new identity is only ever created when
          // `identity` above was already null, which takes the `set-pin` branch instead
          // of reaching this effect's try block at all. Guarded anyway per "no silent
          // failures" — falls back to the unlocked redirect rather than getting stuck.
          router.replace(outcome.nextUrl);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : "Sign-in failed. Please try again.";
        setStatus({ kind: "error", message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bridge, provider, router]);

  async function handlePinSetup(pin: string) {
    if (!bridge || status.kind !== "set-pin") return;
    setStatus({ kind: "working" });
    try {
      const outcome = await completeOAuthSignIn(bridge, provider, status.oauthProof, pin);
      router.replace(outcome.nextUrl);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Sign-in failed. Please try again.";
      setStatus({ kind: "error", message });
    }
  }

  async function handleUnlock(pin: string) {
    if (!bridge || status.kind !== "unlock") return;
    const { nextUrl, refreshToken } = status;
    const ok = await bridge.unlock(pin);
    if (ok) {
      markCryptoBridgeUnlocked();
      await bridge.setRefreshToken(refreshToken);
      router.replace(nextUrl);
      return;
    }
    setStatus({ kind: "unlock", nextUrl, refreshToken, error: "Wrong PIN. Try again." });
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8 text-center">
      {status.kind === "working" && (
        <p className="text-sm text-muted-foreground">Finishing sign-in…</p>
      )}

      {status.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center gap-3">
          <p className="text-sm text-destructive">{status.message}</p>
          <Button variant="outline" onClick={() => router.replace("/signin/")}>
            Back to sign in
          </Button>
        </div>
      )}

      {status.kind === "set-pin" && (
        <div className="w-full max-w-sm">
          <PinSetupForm onSubmit={handlePinSetup} />
        </div>
      )}

      {status.kind === "unlock" && (
        <div className="w-full max-w-sm">
          <PinUnlockForm error={status.error} onSubmit={handleUnlock} />
        </div>
      )}
    </main>
  );
}
