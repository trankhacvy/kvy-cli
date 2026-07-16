/**
 * Old→new provider-session-id lineage (design §7.8 FR-9.5, plan.md §16
 * "3.3 Session adoption (UC9)"): Claude Code's `--resume` mints a brand-new
 * provider session id every time (documented in Happy's `CLAUDE.md` as
 * "Session Forking" and echoed in this project's own `plan.md` §11), so
 * `falcon adopt` records old→new mappings locally in
 * `~/.falcon/settings.json`'s `adoptedSessions` — so a session's history
 * can be presented as one continuous timeline across resumes instead of a
 * chain of apparently-unrelated sessions.
 */
import { type PersistenceOptions, readSettings, updateSettings } from "../persistence.js";

/**
 * `falcon adopt`'s real call site (`commands/adopt.ts`) always passes
 * `listAdoptableSessions()`'s pick as `oldProviderSessionId` — i.e. the
 * *most recently active* transcript on disk. After a first adopt (A -> B),
 * B is now that most-recent transcript, so the next `falcon adopt` records
 * (B, C), not (A, C). Chains must therefore be looked up by *any* id they
 * contain, not just their first (root) element, or each new adopt+resume
 * hop would fragment into its own disconnected 2-entry chain instead of
 * extending the original session's full history.
 */
function findChainEntry(
  adoptedSessions: Record<string, string[]>,
  providerSessionId: string,
): [rootKey: string, chain: string[]] | undefined {
  const direct = adoptedSessions[providerSessionId];
  if (direct) return [providerSessionId, direct];
  for (const [rootKey, chain] of Object.entries(adoptedSessions)) {
    if (chain.includes(providerSessionId)) return [rootKey, chain];
  }
  return undefined;
}

/**
 * Appends `newProviderSessionId` onto whichever lineage chain already
 * contains `oldProviderSessionId` (as its root id *or* any later hop),
 * creating a fresh one-entry chain keyed on `oldProviderSessionId` the
 * first time one doesn't exist. Returns the full chain in adoption order,
 * oldest first, still stored under its original root id so the complete
 * history stays reachable from where it started. Idempotent: re-recording
 * the same `newProviderSessionId` is a no-op.
 */
export async function recordAdoptionLineage(
  oldProviderSessionId: string,
  newProviderSessionId: string,
  options: PersistenceOptions = {},
): Promise<string[]> {
  let chain: string[] = [];
  await updateSettings((current) => {
    const adoptedSessions = { ...(current.adoptedSessions ?? {}) };
    const found = findChainEntry(adoptedSessions, oldProviderSessionId);
    const rootKey = found?.[0] ?? oldProviderSessionId;
    const existing = found?.[1] ?? [oldProviderSessionId];
    chain = existing.includes(newProviderSessionId)
      ? existing
      : [...existing, newProviderSessionId];
    adoptedSessions[rootKey] = chain;
    return { ...current, adoptedSessions };
  }, options);
  return chain;
}

/**
 * Looks up a previously-recorded lineage chain containing
 * `oldProviderSessionId` — whether it's the original root id or a later
 * hop recorded since — or `null` if none was ever recorded.
 */
export async function getAdoptionLineage(
  oldProviderSessionId: string,
  options: PersistenceOptions = {},
): Promise<string[] | null> {
  const settings = await readSettings(options);
  return findChainEntry(settings.adoptedSessions ?? {}, oldProviderSessionId)?.[1] ?? null;
}
