"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { completeOAuthSignIn } from "@/lib/complete-oauth-sign-in";
import { useCryptoBridge } from "@/lib/use-crypto-bridge";
import { RecoveryCodeCard } from "./recovery-code-card";

type Status =
  | { kind: "working" }
  | { kind: "error"; message: string }
  | { kind: "reveal-recovery-code"; recoveryCode: string; nextUrl: string };

/**
 * Shared body for both `/auth/callback/google` and `/auth/callback/github`
 * — everything from here on (identity generation, `POST /v1/auth/register`,
 * the one-time recovery-code reveal, redirect) is provider-agnostic; only
 * how the `oauthProof` was obtained differs between the two pages.
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

      try {
        const outcome = await completeOAuthSignIn(bridge, provider, proof.value);
        if (cancelled) return;
        if (outcome.kind === "new-identity") {
          setStatus({
            kind: "reveal-recovery-code",
            recoveryCode: outcome.recoveryCode,
            nextUrl: outcome.nextUrl,
          });
        } else {
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

      {status.kind === "reveal-recovery-code" && (
        <div className="flex max-w-md flex-col items-center gap-4">
          <h1 className="text-xl font-semibold tracking-tight">Save your recovery code</h1>
          <p className="text-sm text-muted-foreground">
            This is the only way to recover your account on a new device if you lose access to this
            one. Falcon cannot recover it for you — write it down or store it in a password manager.
          </p>
          <RecoveryCodeCard code={status.recoveryCode} />
          <Button type="button" onClick={() => router.replace(status.nextUrl)}>
            I've saved it — continue
          </Button>
        </div>
      )}
    </main>
  );
}
