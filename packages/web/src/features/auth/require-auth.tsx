"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { isSignedIn } from "@/lib/session";

/**
 * Where a signed-out visitor to an auth-gated route is sent — the same
 * target `app/page.tsx`, `settings/recovery/page.tsx`, and
 * `settings/notifications/page.tsx` each hardcode for their own hand-rolled
 * gate. Exported so `shouldRedirectToSignin`'s test (below/`__tests__`) locks
 * the value, not just the boolean.
 */
export const SIGNIN_PATH = "/signin/";

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
  }, [router]);

  if (!checked) return null;
  return <>{children}</>;
}
