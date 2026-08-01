import type { StepUpProvider } from "./pending-stepup.js";

/**
 * `returned` carries a `method` discriminant: the OAuth step-up round trip
 * (`derivePhaseFromReturn` below) and the in-page password step-up form both land here,
 * each with the fields `handleProtectionChoice` needs to call its matching
 * `rotateKeyEpochOAuth`/`rotateKeyEpoch`.
 */
export type ResetKeysPhase =
  | { kind: "confirm-identity" }
  /** The non-destructive path: ask a device that already has the keys for a copy. */
  | { kind: "fetch-keys" }
  | {
      kind: "returned";
      method: "oauth";
      provider: StepUpProvider;
      oauthProof: string;
      refreshToken: string;
    }
  | { kind: "returned"; method: "password"; refreshToken: string; stepUpPassword: string }
  | {
      kind: "rotating";
      error?: string;
      /** Set when `keys/bind`'s "other devices online" 409 is the reason `error` is set —
       *  distinguishes "offer a log-out-others retry button" from a plain failed-rotation
       *  error, whose only recovery is starting over from `confirm-identity`. */
      otherDevicesOnline?: boolean;
    }
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
  return { kind: "returned", method: "oauth", ...ret };
}
