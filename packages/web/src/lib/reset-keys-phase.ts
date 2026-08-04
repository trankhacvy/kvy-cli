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
  | { kind: "rotating"; error?: string }
  | { kind: "error"; message: string };

/**
 * Pure derivation of `/reset-keys/`'s return-leg phase transition - extracted so it is
 * testable without mounting React.
 *
 * Deliberately entry-state-agnostic: `/reset-keys/` is reachable from both a `no-identity`
 * visitor and a `needs-unlock` one. The only question asked is whether the OAuth callback
 * left an in-memory return payload, so both entrant types land on the same `"returned"` phase
 * identically once they complete the provider round trip.
 */
export function derivePhaseFromReturn(
  ret: { provider: StepUpProvider; oauthProof: string; refreshToken: string } | null,
): ResetKeysPhase {
  if (!ret) return { kind: "confirm-identity" };
  return { kind: "returned", method: "oauth", ...ret };
}
