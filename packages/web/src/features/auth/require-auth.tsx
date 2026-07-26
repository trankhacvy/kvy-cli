"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KeyRequestListener } from "@/components/auth/key-request-listener";
import { MigratePinPrompt } from "@/components/auth/migrate-pin-prompt";
import { RequestKeysPanel } from "@/components/auth/request-keys-panel";
import { Button } from "@/components/ui/button";
import { copy } from "@/lib/copy";
import { getAccountId, isSignedIn, silentRefresh } from "@/lib/session";
import { useCryptoBridgeStatus } from "@/lib/use-crypto-bridge-status";

export const SIGNIN_PATH = "/signin/";

/**
 * Where a *silently-failed-refresh* redirect lands — same route, `?reason=expired`
 * appended so `/signin/` can explain why the visitor is here instead of looking like a
 * bare cold visit. Deliberate logouts keep using plain `SIGNIN_PATH`.
 */
export const SIGNIN_EXPIRED_PATH = "/signin/?reason=expired";

/** How often the session is re-checked while a protected route stays mounted — a token
 * that expires on-page is silently refreshed within one tick, rather than surfacing as a
 * rejected socket reconnect. Comfortably inside the 15-minute access-token TTL. */
const EXPIRY_CHECK_INTERVAL_MS = 60_000;

export function shouldRedirectToSignin(signedIn: boolean): boolean {
  return !signedIn;
}

/**
 * Auth gate for every protected page.
 *
 * Static export → this has to stay a client-side gate (design §5.3: no server ever
 * renders user content). `children` never renders — not even for a frame — for a
 * signed-out visitor.
 *
 * docs/auth-ux-overhaul-plan.md Phase 4a: the SESSION check runs independently of key
 * material now. The refresh token lives in its own store, so a browser with no keys can
 * still be signed in — which is exactly the state `RequestKeysPanel` needs in order to
 * ask another device for a copy. Gating the session on crypto readiness (as this did
 * before) made that state unreachable and left the user staring at a spinner.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  /** `null` until the session effect below confirms a real access token — on a cold load
   *  that's AFTER this component's first render, so `useCryptoBridgeStatus` must stay
   *  `"loading"` until then rather than evaluating readiness for nobody in particular
   *  (auth-ux-overhaul-fix-plan.md Fix 4 Part C). */
  const [accountId, setAccountId] = useState<string | null>(null);
  const { status, refresh } = useCryptoBridgeStatus(accountId);
  const [sessionReady, setSessionReady] = useState(false);
  /** Set when a refresh could not reach the server at all — distinct from signed-out, which
   *  redirects. Without this the gate renders `null` forever and the user sees a blank page
   *  with no explanation: `OfflineBanner` mounts INSIDE this gate and can never help here. */
  const [unreachable, setUnreachable] = useState(false);
  /** Bumped by the retry button to re-run the effect below on demand, on top of its own
   *  60s interval. */
  const [retryCount, setRetryCount] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount is an "epoch" counter the retry button bumps purely to force this effect to re-run on demand — it's never read inside.
  useEffect(() => {
    let cancelled = false;

    async function ensureSession(): Promise<void> {
      if (isSignedIn()) {
        if (!cancelled) {
          setUnreachable(false);
          setAccountId(getAccountId());
          setSessionReady(true);
        }
        return;
      }
      const result = await silentRefresh();
      if (cancelled) return;
      if (result === "ok") {
        setUnreachable(false);
        setAccountId(getAccountId());
        setSessionReady(true);
      } else if (result === "signed-out") {
        router.replace(SIGNIN_EXPIRED_PATH);
      } else {
        // Only a server-side rejection means "sign in again". A transport fault leaves the
        // gate on its own 60s re-check instead of throwing away a session that is probably
        // fine — the offline case is a wait, not a logout.
        setUnreachable(true);
      }
    }

    void ensureSession();
    const interval = setInterval(() => void ensureSession(), EXPIRY_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [router, retryCount]);

  if (!sessionReady && unreachable) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">{copy.session.cantReachServer}</p>
        <Button type="button" onClick={() => setRetryCount((count) => count + 1)}>
          {copy.session.retryCta}
        </Button>
      </main>
    );
  }

  if (!sessionReady) return null;

  if (status.kind === "needs-migration") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <MigratePinPrompt onMigrated={() => void refresh()} />
      </main>
    );
  }

  if (status.kind === "locked-out") {
    // The keys ARE on this browser; the passkey check was dismissed or failed. Offering
    // to re-fetch them from another device would be the wrong answer here.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          We couldn't confirm it's you on this device.
        </p>
        <Button type="button" onClick={() => void refresh()}>
          Try again
        </Button>
      </main>
    );
  }

  if (status.kind === "no-keys") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <RequestKeysPanel onReady={() => void refresh()} />
      </main>
    );
  }

  if (status.kind !== "ready") return null;

  return (
    <>
      {children}
      <KeyRequestListener />
    </>
  );
}
