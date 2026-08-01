/**
 * Preserves an in-progress "reset keys" step-up across the OAuth redirect detour.
 * `/reset-keys/` calls `stashPendingStepUp({ provider })` before sending the browser to
 * Google/GitHub. The OAuth callback, seeing this flag, COMPLETES sign-in (register + setToken)
 * and then hands the fresh refresh token + resolved proof to `/reset-keys/` via the in-memory
 * `stepUpReturn` channel below — NOT sessionStorage: the proof is a live bearer credential and
 * the refresh token must never leave the worker's custody model into web storage (security
 * review finding F1, `lib/session.ts`'s header). The callback→/reset-keys/ hop is an SPA
 * navigation (`router.replace`) in the same JS realm, so a module variable survives it. The
 * `sessionStorage` flag exists only because the *provider* redirect is a real full-page
 * navigation that wipes module memory — mirrors `lib/pending-pair.ts`'s single-visit shape,
 * plus a provider tag and a timestamp.
 */

const PENDING_STEPUP_KEY = "kvy:pendingStepUp";
const PENDING_STEPUP_TTL_MS = 5 * 60_000; // an OAuth consent round trip; abandoned attempts expire

export type StepUpProvider = "google" | "github";

interface PendingStepUpFlag {
  provider: StepUpProvider;
  ts: number;
}

export function stashPendingStepUp(value: { provider: StepUpProvider }): void {
  const flag: PendingStepUpFlag = { provider: value.provider, ts: Date.now() };
  window.sessionStorage.setItem(PENDING_STEPUP_KEY, JSON.stringify(flag));
}

/** One-shot: reads AND clears the flag. Returns null if absent, malformed, expired, or (when
 * `expectProvider` is given) for a different provider than the one that started this round trip
 * — the confused-deputy guard: an abandoned Google step-up can't divert a later GitHub (or a
 * plain) sign-in in the same tab. */
export function consumePendingStepUp(expectProvider?: StepUpProvider): StepUpProvider | null {
  const raw = window.sessionStorage.getItem(PENDING_STEPUP_KEY);
  window.sessionStorage.removeItem(PENDING_STEPUP_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "provider" in parsed &&
      "ts" in parsed &&
      (parsed.provider === "google" || parsed.provider === "github") &&
      typeof (parsed as PendingStepUpFlag).ts === "number" &&
      Date.now() - (parsed as PendingStepUpFlag).ts < PENDING_STEPUP_TTL_MS
    ) {
      const provider = (parsed as PendingStepUpFlag).provider;
      if (expectProvider && provider !== expectProvider) return null;
      return provider;
    }
  } catch {
    // fall through
  }
  return null;
}

/** In-memory-only return channel (callback → /reset-keys/). Deliberately NOT sessionStorage —
 * holds a live OAuth proof and a refresh token; both die with a real page reload, which is the
 * correct fail-safe (the user just re-runs the step-up). */
export interface StepUpReturn {
  provider: StepUpProvider;
  oauthProof: string;
  refreshToken: string;
}

let stepUpReturn: StepUpReturn | null = null;

export function setStepUpReturn(value: StepUpReturn): void {
  stepUpReturn = value;
}

/** One-shot read: returns and clears the in-memory payload. */
export function takeStepUpReturn(): StepUpReturn | null {
  const value = stepUpReturn;
  stepUpReturn = null;
  return value;
}
