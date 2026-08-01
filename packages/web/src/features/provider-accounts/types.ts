import type { ProviderAccountResult, ProviderId, ProviderUsageMeter } from "@kvy/wire";

/**
 * View-model types for Settings → Providers (docs/competitive-notes-omnara.md
 * #9 "Provider account inspection + usage metering"): live, refreshable
 * account metadata per machine — provider, auth type, email, organization,
 * billing type, org role, last-refreshed timestamp, plus a usage meter with
 * a reset date — read straight off the local CLI's own auth config files
 * (`~/.claude.json`, `~/.codex/auth.json`) via the new `provider.account`
 * machine RPC (`packages/cli/src/daemon/providerAccountInfo.ts`).
 *
 * `ProviderAccountSnapshot`/`ProviderUsageMeter` are re-exported straight off
 * `@kvy/wire` rather than redeclared — same "the RPC result is already
 * exactly what this screen wants to render" precedent as `features/git-diff/
 * types.ts`'s `GitStatusSnapshot`.
 */
export type ProviderAccountSnapshot = ProviderAccountResult;
export type { ProviderUsageMeter };

export type ProviderAccountProvider = ProviderId;

/**
 * The RPC surface this feature needs, seamed off from *how* the call
 * reaches the daemon — mirrors `features/git-diff`'s `GitDiffActions` /
 * `features/new-session`'s `NewSessionActions` pattern exactly. Real
 * default (`use-live-provider-account-actions.ts`) is
 * `machineRpcToProviderAccountActions(createMachineRpcClient({...}))`;
 * `mock-source.ts`'s mock stays exported for tests/standalone review.
 */
export interface ProviderAccountActions {
  /** Fetches `provider`'s account info for the target machine. Never rejects on "not authenticated" — that's a valid, honest result (`authenticated: false`); only a genuine transport/RPC failure (unreachable machine, decrypt failure, ...) throws. */
  fetchAccount(provider: ProviderAccountProvider): Promise<ProviderAccountSnapshot>;
}

/** One provider-account actions client per chosen machine — mirrors `UseGitDiffActions = (machineId) => GitDiffActions`. */
export type UseProviderAccountActions = (machineId: string) => ProviderAccountActions;
