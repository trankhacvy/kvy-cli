// Only the refresh token is ever written to `~/.kvy/access.key`; each call to
// `resolveAccessToken` mints a fresh access token on demand.

import { resolveHomeDir } from "../home.js";
import type { Logger } from "../logger.js";
import { type KvyCredentials, readCredentials, writeCredentials } from "./credentials.js";
import { withCredentialsLock } from "./credentialsLock.js";
import { createTokenProvider, type TokenProvider } from "./tokenProvider.js";

export interface ResolveAccessTokenOptions {
  backendUrl: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Builds a `TokenProvider` for callers that need to keep minting fresh access tokens
 * across a long-running process (e.g. a daemon session), rather than resolving once.
 */
export function createTokenProviderForCredentials(
  credentials: KvyCredentials,
  options: ResolveAccessTokenOptions,
): TokenProvider {
  const homeDir = options.homeDir ?? resolveHomeDir();
  return createTokenProvider({
    backendUrl: options.backendUrl,
    refreshToken: credentials.refreshToken,
    fetchImpl: options.fetchImpl ?? fetch,
    now: () => Date.now(),
    onRotate: (refreshToken) => {
      writeCredentials({ ...credentials, refreshToken }, homeDir);
    },
    logger: options.logger ?? noopLogger,
    // This long-lived provider can outlive many refresh-token rotations by sibling
    // processes (e.g. the daemon's own TokenProvider) — re-read `~/.kvy/access.key`
    // on a 401 before giving up permanently.
    readCurrentRefreshToken: () => readCredentials(homeDir)?.refreshToken ?? null,
    // This session-owned provider and the daemon's own both rotate the same on-disk
    // refresh token — serialize actual refresh attempts against each other instead of racing.
    withCredentialsLock: (fn) => withCredentialsLock(homeDir, fn),
  });
}

/** Returns a valid access token for `credentials`, or `null` if the refresh token is dead (re-authentication required). */
export async function resolveAccessToken(
  credentials: KvyCredentials,
  options: ResolveAccessTokenOptions,
): Promise<string | null> {
  const provider = createTokenProviderForCredentials(credentials, options);
  const token = await provider.getAccessToken();
  if (!provider.isDead) return token;

  // The refresh token we started with may already be one rotation behind another
  // process sharing this home dir (the daemon's `machineClient.ts` renewing on its own
  // schedule, or a long-running `kvy claude` session's own preflight token provider) —
  // refresh.ts rotates single-use, with only a 60s grace for the immediately-previous
  // hash, so a stale-by-one read 401s even though the account is genuinely signed in.
  // Re-read the credentials file once — another process may have already persisted the
  // newer token — and retry with THAT before giving up.
  const fresh = readCredentials(options.homeDir);
  if (!fresh || fresh.refreshToken === credentials.refreshToken) return null;
  return createTokenProviderForCredentials(fresh, options).getAccessToken();
}
