import type { StepUpProvider } from "./pending-stepup.js";

export type ResetKeysPhase =
  | { kind: "confirm-identity" }
  | { kind: "returned"; provider: StepUpProvider; oauthProof: string; refreshToken: string }
  | { kind: "rotating"; error?: string }
  | { kind: "error"; message: string };

/**
 * Pure derivation of `/reset-keys/`'s return-leg phase transition — pulled out of the page
 * component (a Next.js `page.tsx` using `next/navigation`'s `useRouter`, which this package's
 * `environment: "node"` vitest config can't render — see `app/(public)/signin/page.test.ts`'s
 * doc comment) so it's directly testable without mounting React, mirroring
 * `features/auth/require-auth.tsx`'s `shouldRedirectToSignin`.
 *
 * Deliberately entry-state-agnostic: `/reset-keys/` is reachable from BOTH a `no-identity`
 * visitor (device wiped / genuinely new) and a `needs-unlock` one (forgotten PIN) — see
 * docs/auth-ux-hardening-plan.md item 2b/4 "review Problem 3". The page never branches on
 * either status kind; the only question this function (and the page) asks is whether the OAuth
 * callback left an in-memory return payload (`lib/pending-stepup.ts`'s `takeStepUpReturn()`),
 * so both entrants land on the same `"returned"` (PIN-setup) phase identically once they
 * complete the provider round trip.
 */
export function derivePhaseFromReturn(
  ret: { provider: StepUpProvider; oauthProof: string; refreshToken: string } | null,
): ResetKeysPhase {
  if (!ret) return { kind: "confirm-identity" };
  return { kind: "returned", ...ret };
}
