/**
 * issue-4-plan.md §6.6: replaces the static `token: string` every daemon/CLI network
 * client used to be handed — that fixed 1h JWT was the root cause of "daemon silently
 * dies after 1h" (known-issues.md #4): once it expired, `machineClient.ts` retried the
 * dead credential forever with no way to mint a fresh one.
 *
 * `TokenProvider` mints access tokens from a persistent refresh token
 * (`POST /v1/auth/refresh`), caches the current one until shortly before its own `exp`
 * claim, and persists each rotation back to disk via the injected `onRotate`. A refresh
 * that comes back definitively rejected (401) means the credential is dead — callers
 * should stop retrying and tell the user to run `falcon auth login` again, not loop
 * forever on a corpse the way the old fixed-token path did.
 */
import type { Logger } from "../logger.js";
import { decodeTokenClaimsUnverified } from "./jwt.js";

// Refresh proactively before the access token actually expires — mirrors the server's
// own §4.5 in-band `renew-token` timing (~1m headroom) so a caller never observes a
// token that's valid-on-paper but about to be rejected mid-request.
const REFRESH_SKEW_MS = 60_000;

export interface TokenProviderDeps {
  backendUrl: string;
  /** The current refresh token — mutated in place by `onRotate` is the CALLER's job; this module only reads it once at construction and thereafter tracks rotations internally. */
  refreshToken: string;
  fetchImpl: typeof fetch;
  now: () => number;
  /** Persist a rotated refresh token (e.g. back to `~/.falcon/access.key`). */
  onRotate: (refreshToken: string) => void | Promise<void>;
  logger: Logger;
}

export interface TokenProvider {
  /** Returns a valid access token, refreshing first if the cached one is stale/absent. `null` means the refresh token is dead — re-authentication is required. */
  getAccessToken(): Promise<string | null>;
  /** Forces a refresh regardless of the cached token's apparent freshness (e.g. after a `connect_error`/401 that implies the access token was rejected early). */
  forceRefresh(): Promise<string | null>;
  /** True once a refresh has come back definitively rejected — the caller should stop retrying and prompt re-login. */
  readonly isDead: boolean;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export function createTokenProvider(deps: TokenProviderDeps): TokenProvider {
  let refreshToken = deps.refreshToken;
  let cachedAccessToken: string | null = null;
  let cachedExpiresAtMs = 0;
  let dead = false;
  let inFlight: Promise<string | null> | null = null;

  async function doRefresh(): Promise<string | null> {
    if (dead) return null;

    try {
      const res = await deps.fetchImpl(`${deps.backendUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (res.status === 401) {
        dead = true;
        deps.logger.error(
          "[token-provider] refresh token rejected — re-authentication required, run `falcon auth login`",
        );
        return null;
      }
      if (!res.ok) {
        deps.logger.warn("[token-provider] refresh failed (non-401)", { status: res.status });
        return null;
      }

      const body = (await res.json()) as RefreshResponse;
      refreshToken = body.refreshToken;
      cachedAccessToken = body.accessToken;
      const claims = decodeTokenClaimsUnverified(body.accessToken);
      cachedExpiresAtMs = claims ? claims.expiresAt * 1000 : deps.now() + REFRESH_SKEW_MS;

      // Persisting the rotation is best-effort: a caller must still get back the access
      // token it just legitimately obtained even if writing the new refresh token to
      // disk fails (e.g. a transient FS error) — the in-memory cache above already has
      // it, so the failure only costs "the NEXT process start re-refreshes instead of
      // reusing the rotated token," never the current call.
      try {
        await deps.onRotate(refreshToken);
      } catch (error) {
        deps.logger.warn("[token-provider] failed to persist rotated refresh token", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return cachedAccessToken;
    } catch (error) {
      deps.logger.warn("[token-provider] refresh request threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Concurrent callers (e.g. several requests firing right as the cached token goes
  // stale) share one in-flight refresh instead of each rotating the token out from
  // under the others.
  function refreshOnce(): Promise<string | null> {
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    get isDead() {
      return dead;
    },
    async getAccessToken() {
      if (cachedAccessToken && deps.now() < cachedExpiresAtMs - REFRESH_SKEW_MS) {
        return cachedAccessToken;
      }
      return refreshOnce();
    },
    async forceRefresh() {
      cachedAccessToken = null;
      return refreshOnce();
    },
  };
}
