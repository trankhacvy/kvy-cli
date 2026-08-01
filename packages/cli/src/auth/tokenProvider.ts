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
 * should stop retrying and tell the user to run `kvy auth login` again, not loop
 * forever on a corpse the way the old fixed-token path did.
 */
import { z } from "zod";
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
  /** Persist a rotated refresh token (e.g. back to `~/.kvy/access.key`). */
  onRotate: (refreshToken: string) => void | Promise<void>;
  logger: Logger;
  /**
   * Re-reads whatever refresh token is CURRENTLY persisted on disk (e.g.
   * `~/.kvy/access.key`) — a last-chance mitigation for the same hazard
   * `resolveAccessToken.ts`'s one-shot helper already documents: this refresh token may
   * already be one rotation behind another long-lived process sharing the same home dir
   * (the daemon's own `TokenProvider` vs. a `kvy claude` session's), since rotation
   * is single-use with only a 60s grace window. On a 401, if the disk copy differs from
   * the one that was just rejected, one retry is made with the disk copy before this
   * instance is marked permanently `dead` — a sibling process may have already rotated
   * in a newer token. Optional: omitted (e.g. in tests, or when there's genuinely
   * nothing else to read) means a 401 is always treated as definitively dead, matching
   * this module's previous behavior.
   */
  readCurrentRefreshToken?: () => string | null;
  /**
   * Serializes a refresh attempt (network call + `onRotate` persist) against sibling
   * processes sharing the same on-disk refresh token, so at most one of them is ever
   * actually rotating it at a time (known-issues.md #20: two siblings racing on
   * `/v1/auth/refresh` is what causes a benign same-machine race to look like token
   * theft and revoke the whole device family). Optional: omitted means no
   * coordination, matching this module's previous behavior.
   */
  withCredentialsLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface TokenProvider {
  /** Returns a valid access token, refreshing first if the cached one is stale/absent. `null` means the refresh token is dead — re-authentication is required. */
  getAccessToken(): Promise<string | null>;
  /** Forces a refresh regardless of the cached token's apparent freshness (e.g. after a `connect_error`/401 that implies the access token was rejected early). */
  forceRefresh(): Promise<string | null>;
  /** True once a refresh has come back definitively rejected — the caller should stop retrying and prompt re-login. */
  readonly isDead: boolean;
}

// Reviewer nit (security review, closing before merge): parse-don't-trust, matching
// this codebase's own convention (`auth/pair.ts`, `auth/credentials.ts`) instead of a
// bare `as RefreshResponse` type assertion over an untyped `res.json()`.
const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});

export function createTokenProvider(deps: TokenProviderDeps): TokenProvider {
  let refreshToken = deps.refreshToken;
  let cachedAccessToken: string | null = null;
  let cachedExpiresAtMs = 0;
  let dead = false;
  let inFlight: Promise<string | null> | null = null;

  async function doRefresh(retriedStaleToken = false): Promise<string | null> {
    if (dead) return null;

    // Proactive resync (known-issues.md #20): before presenting a token over the
    // network at all, check whether a sibling process already rotated it out from
    // under us — the common case in practice, not just a millisecond-level race. A
    // stale-by-one token that only gets caught reactively on a 401 may already have
    // been outside the server's grace window by then, which revokes the whole device
    // family instead of just failing this one request.
    if (!retriedStaleToken) {
      const onDisk = deps.readCurrentRefreshToken?.() ?? null;
      if (onDisk && onDisk !== refreshToken) {
        deps.logger.warn(
          "[token-provider] adopting a refresh token a sibling process already rotated to, before refreshing",
        );
        refreshToken = onDisk;
      }
    }

    try {
      const res = await deps.fetchImpl(`${deps.backendUrl}/v1/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (res.status === 401) {
        // Stale-by-one mitigation (issue #2, docs/known-issues-cliweb-sync-test.md):
        // before condemning this instance forever, check whether a sibling process
        // (the daemon vs. a `kvy claude` session, both reading/writing the same
        // `~/.kvy/access.key`) already rotated the single-use refresh token out from
        // under us. Only retried once — if the disk copy is unchanged, or the retry
        // itself 401s, the token really is dead.
        if (!retriedStaleToken) {
          const onDisk = deps.readCurrentRefreshToken?.() ?? null;
          if (onDisk && onDisk !== refreshToken) {
            deps.logger.warn(
              "[token-provider] refresh token rejected but a newer one is on disk (likely rotated by a sibling process) — retrying once",
            );
            refreshToken = onDisk;
            return doRefresh(true);
          }
        }

        dead = true;
        deps.logger.error(
          "[token-provider] refresh token rejected — re-authentication required, run `kvy auth login`",
        );
        return null;
      }
      if (!res.ok) {
        deps.logger.warn("[token-provider] refresh failed (non-401)", { status: res.status });
        return null;
      }

      const parsed = RefreshResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        deps.logger.warn("[token-provider] refresh response failed schema validation", {
          error: parsed.error.message,
        });
        return null;
      }
      const body = parsed.data;
      // known-issues.md #20: on a benign same-family race, the server can't hand back
      // the real current refresh token (it only stores a hash) — it echoes back
      // whatever this call presented, unchanged. That's not a rotation; persisting it
      // would just rewrite disk with the same already-superseded value, potentially
      // clobbering a sibling's genuinely newer one. Only treat this as a rotation (and
      // only then persist) when the token actually changed.
      const rotated = body.refreshToken !== refreshToken;
      refreshToken = body.refreshToken;
      cachedAccessToken = body.accessToken;
      const claims = decodeTokenClaimsUnverified(body.accessToken);
      cachedExpiresAtMs = claims ? claims.expiresAt * 1000 : deps.now() + REFRESH_SKEW_MS;

      if (rotated) {
        // Persisting the rotation is best-effort: a caller must still get back the
        // access token it just legitimately obtained even if writing the new refresh
        // token to disk fails (e.g. a transient FS error) — the in-memory cache above
        // already has it, so the failure only costs "the NEXT process start
        // re-refreshes instead of reusing the rotated token," never the current call.
        try {
          await deps.onRotate(refreshToken);
        } catch (error) {
          deps.logger.warn("[token-provider] failed to persist rotated refresh token", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
  // under the others. `withCredentialsLock` wraps the whole attempt (including its at
  // most one stale-by-one retry) so a sibling process never observes this instance
  // mid-refresh.
  function refreshOnce(): Promise<string | null> {
    if (!inFlight) {
      const withLock = deps.withCredentialsLock;
      inFlight = (withLock ? withLock(doRefresh) : doRefresh()).finally(() => {
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
