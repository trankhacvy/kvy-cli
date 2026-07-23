"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PinUnlockForm } from "@/components/auth/pin-unlock-form";
import { isSignedIn, silentRefresh } from "@/lib/session";
import { useUnlockedCryptoBridge } from "@/lib/use-unlocked-crypto-bridge";

/**
 * Where a signed-out visitor to an auth-gated route is sent. Exported so
 * `shouldRedirectToSignin`'s test (below/`__tests__`) locks the value, not
 * just the boolean.
 */
export const SIGNIN_PATH = "/signin/";

/** How often `RequireAuth` re-checks the session while a protected route stays mounted
 * — the proactive half of bug-fix-plan.md issue #9: a token that expires *while the
 * user is already on the page* should be silently refreshed within one tick of this
 * interval, rather than only being caught the next time the layout happens to remount
 * (or, worse, only surfacing once the socket's next reconnect attempt gets rejected —
 * issue #10). Comfortably inside the 15-minute access-token TTL (§8 Phase 6). */
const EXPIRY_CHECK_INTERVAL_MS = 60_000;

/** The gate's actual decision, pulled out of the component so it's testable
 * without mounting React (this package has no DOM test environment — see
 * `__tests__/require-auth.test.ts`). */
export function shouldRedirectToSignin(signedIn: boolean): boolean {
  return !signedIn;
}

/**
 * Auth-gate for a page component (W1.9, plan.md §16 wave 1: `/session/[id]`,
 * `/session/[id]/git`, `/session/new` all render for signed-out visitors
 * today and then throw from `getToken()` inside a hook). Extracted out of
 * `app/page.tsx`'s own inline `isSignedIn()` + `router.replace("/signin/")`
 * effect so all four call sites share one gate instead of a fourth
 * hand-rolled copy.
 *
 * Static export → this has to stay a client-side gate (design §5.3: no
 * server ever renders user content, so there's no server-side redirect to
 * do this with instead). `children` never renders — not even for a single
 * frame — for a signed-out visitor; a bare render-time check would flash
 * `children` on a client-side navigation into the route, where there's no
 * server-rendered HTML for this check to run against before paint.
 *
 * issue-4-plan.md §6.1/§6.4, security review finding F1: the crypto-worker-unlock gate
 * is now the FIRST gate, not a second one layered after an independent token check —
 * the refresh token only exists PIN-wrapped inside the worker (`lib/session.ts`'s
 * `silentRefresh` reads it via `getSharedCryptoBridge()`, which resolves to nothing
 * until the worker is unlocked), so there is no token to refresh FROM until
 * `useUnlockedCryptoBridge()` reports `"ready"`. Once it does, this re-checks/refreshes
 * the in-memory access token on the same `EXPIRY_CHECK_INTERVAL_MS` timer as before,
 * for as long as the gate stays mounted.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, unlock } = useUnlockedCryptoBridge();
  const [sessionReady, setSessionReady] = useState(false);
  const [unlockError, setUnlockError] = useState<string | undefined>(undefined);
  const [unlocking, setUnlocking] = useState(false);

  useEffect(() => {
    if (status.kind !== "ready") return;
    let cancelled = false;

    async function ensureSession(): Promise<void> {
      if (isSignedIn()) {
        if (!cancelled) setSessionReady(true);
        return;
      }
      const refreshed = await silentRefresh();
      if (cancelled) return;
      if (refreshed) {
        setSessionReady(true);
      } else {
        router.replace(SIGNIN_PATH);
      }
    }

    void ensureSession();

    const interval = setInterval(() => {
      void ensureSession();
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, router]);

  async function handleUnlock(pin: string): Promise<void> {
    setUnlocking(true);
    setUnlockError(undefined);
    const ok = await unlock(pin);
    setUnlocking(false);
    if (!ok) setUnlockError("Wrong PIN. Try again.");
  }

  // No local identity at all (device wiped, or genuinely new to this account) — not
  // this gate's job to recover: point at pairing/settings rather than block forever.
  if (status.kind === "no-identity") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          This browser has no Falcon key material for your account. Pair it from a device that
          already has your keys, or use "Forgot your PIN?" on the sign-in page to generate new ones.
        </p>
      </main>
    );
  }

  if (status.kind === "needs-unlock") {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <PinUnlockForm
            pending={unlocking}
            error={unlockError}
            onSubmit={handleUnlock}
            // issue-4-plan.md §6.2/§6.4: the actual rotate-epoch flow lives on
            // `/password/`'s post-login step machine (it needs the account's
            // password re-entered as the step-up proof) — this gate just routes a
            // forgotten-PIN visitor there instead of duplicating that flow here.
            onForgotPin={() => router.push("/password/")}
          />
        </div>
      </main>
    );
  }

  if (status.kind !== "ready" || !sessionReady) return null;
  return <>{children}</>;
}
