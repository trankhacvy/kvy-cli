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
import { type FalconCredentials, writeCredentials } from "./credentials.js";
import { createTokenProvider } from "./tokenProvider.js";

export interface ResolveAccessTokenOptions {
  backendUrl: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Returns a valid access token for `credentials`, or `null` if the refresh token is dead (re-authentication required). */
export async function resolveAccessToken(
  credentials: FalconCredentials,
  options: ResolveAccessTokenOptions,
): Promise<string | null> {
  const provider = createTokenProvider({
    backendUrl: options.backendUrl,
    refreshToken: credentials.refreshToken,
    fetchImpl: options.fetchImpl ?? fetch,
    now: () => Date.now(),
    onRotate: (refreshToken) => {
      writeCredentials({ ...credentials, refreshToken }, options.homeDir);
    },
    logger: options.logger ?? noopLogger,
  });
  return provider.getAccessToken();
}
