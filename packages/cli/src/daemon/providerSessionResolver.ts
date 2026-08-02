/**
 * Resolves a bare provider session id back to its registered workspace.
 * No default is provided — callers must wire a real implementation.
 */

export interface ResolvedProviderSession {
  workspaceId: string;
  /** Absolute working-directory path Claude Code was run in for this provider session. */
  directory: string;
}

export type ProviderSessionResolver = (
  providerSessionId: string,
) => Promise<ResolvedProviderSession | null>;
