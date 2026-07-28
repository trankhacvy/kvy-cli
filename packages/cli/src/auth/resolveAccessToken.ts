/**
 * issue-4-plan.md §6.6: the shared "turn stored credentials into a currently-valid
 * access token" step every one-shot CLI command (as opposed to the long-lived daemon,
 * which needs the full `TokenProvider` object — see `daemon/machineClient.ts`) now goes
 * through, instead of reading the old fixed `credentials.token` straight off disk. A
 * one-shot process naturally gets a fresh token on every invocation this way, without
 * needing to persist an access token at all — only the refresh token is ever written to
 * `~/.falcon/access.key`.
 */

import type { Logger } from "../logger.js";
import { type FalconCredentials, readCredentials, writeCredentials } from "./credentials.js";
import { createTokenProvider, type TokenProvider } from "./tokenProvider.js";

export interface ResolveAccessTokenOptions {
  backendUrl: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Builds a `TokenProvider` bound to `credentials`' refresh token, persisting each
 * rotation back to `~/.falcon/access.key` — the same construction `resolveAccessToken`
 * below uses internally, exposed directly for callers (issue-4-plan.md §6.6:
 * `commands/start.ts`'s `falcon claude` session path) that need to keep minting fresh
 * access tokens for the lifetime of a long-running process, not just once at startup.
 */
export function createTokenProviderForCredentials(
  credentials: FalconCredentials,
  options: ResolveAccessTokenOptions,
): TokenProvider {
  return createTokenProvider({
    backendUrl: options.backendUrl,
    refreshToken: credentials.refreshToken,
    fetchImpl: options.fetchImpl ?? fetch,
    now: () => Date.now(),
    onRotate: (refreshToken) => {
      writeCredentials({ ...credentials, refreshToken }, options.homeDir);
    },
    logger: options.logger ?? noopLogger,
    // issue #2 (docs/known-issues-cliweb-sync-test.md): this long-lived provider can
    // outlive many refresh-token rotations by sibling processes (the daemon's own
    // `TokenProvider` in `daemon/machineIntegration.ts` chief among them) — re-read
    // `~/.falcon/access.key` on a 401 before giving up permanently.
    readCurrentRefreshToken: () => readCredentials(options.homeDir)?.refreshToken ?? null,
  });
}

/** Returns a valid access token for `credentials`, or `null` if the refresh token is dead (re-authentication required). */
export async function resolveAccessToken(
  credentials: FalconCredentials,
  options: ResolveAccessTokenOptions,
): Promise<string | null> {
  const provider = createTokenProviderForCredentials(credentials, options);
  const token = await provider.getAccessToken();
  if (!provider.isDead) return token;

  // The refresh token we started with may already be one rotation behind another
  // process sharing this home dir (the daemon's `machineClient.ts` renewing on its own
  // schedule, or a long-running `falcon claude` session's own preflight token
  // provider) — `refresh.ts` rotates single-use, with only a 60s grace for the
  // immediately-previous hash, so a stale-by-one read 401s even though the account is
  // genuinely signed in. Re-read the credentials file once — another process may have
  // already persisted the newer token — and retry with THAT before giving up.
  const fresh = readCredentials(options.homeDir);
  if (!fresh || fresh.refreshToken === credentials.refreshToken) return null;
  return createTokenProviderForCredentials(fresh, options).getAccessToken();
}
