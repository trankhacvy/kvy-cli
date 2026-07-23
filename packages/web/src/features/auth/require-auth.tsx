"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { isSignedIn } from "@/lib/session";

/**
 * Where a signed-out visitor to an auth-gated route is sent. Exported so
 * `shouldRedirectToSignin`'s test (below/`__tests__`) locks the value, not
 * just the boolean.
 */
export const SIGNIN_PATH = "/signin/";

/** How often `RequireAuth` re-checks `isSignedIn()` (which now also folds in
 * `isTokenExpired()`, see `lib/session.ts`) while a protected route stays
 * mounted — the proactive half of bug-fix-plan.md issue #9: a token that
 * expires *while the user is already on the page* should redirect them
 * within one tick of this interval, rather than only being caught the next
 * time the layout happens to remount (or, worse, only surfacing once the
 * socket's next reconnect attempt gets rejected — issue #10). One minute
 * comfortably beats the design's stated "1h, auto-refresh" JWT lifetime by a
 * wide margin without polling `localStorage`/decoding the token needlessly
 * often. */
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
 * do this with instead). `checked` starts `false` and only flips `true`
 * once `isSignedIn()` has been confirmed inside an effect, so `children`
 * never renders — not even for a single frame — for a signed-out visitor;
 * a bare render-time check would flash `children` on a client-side
 * navigation into the route, where there's no server-rendered HTML for this
 * check to run against before paint.
 *
 * Also re-checks `isSignedIn()` on a `EXPIRY_CHECK_INTERVAL_MS` timer for as
 * long as the gate stays mounted (bug-fix-plan.md issue #9) — Next's App
 * Router keeps a shared layout like this one mounted across navigations
 * within the same route group, so this interval keeps running for the whole
 * time a visitor stays inside the protected area, catching a token that
 * expires mid-session instead of only ever checking once at mount.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (shouldRedirectToSignin(isSignedIn())) {
      router.replace(SIGNIN_PATH);
      return;
    }
    setChecked(true);

    const interval = setInterval(() => {
      if (shouldRedirectToSignin(isSignedIn())) {
        router.replace(SIGNIN_PATH);
      }
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [router]);

  if (!checked) return null;
  return <>{children}</>;
}
