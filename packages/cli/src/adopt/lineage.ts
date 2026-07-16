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
 * Appends `newProviderSessionId` onto `oldProviderSessionId`'s lineage
 * chain (creating a fresh one-entry chain the first time), returning the
 * full chain in adoption order, oldest first. Idempotent: re-recording the
 * same `newProviderSessionId` is a no-op.
 */
export async function recordAdoptionLineage(
  oldProviderSessionId: string,
  newProviderSessionId: string,
  options: PersistenceOptions = {},
): Promise<string[]> {
  let chain: string[] = [];
  await updateSettings((current) => {
    const adoptedSessions = { ...(current.adoptedSessions ?? {}) };
    const existing = adoptedSessions[oldProviderSessionId] ?? [oldProviderSessionId];
    chain = existing.includes(newProviderSessionId)
      ? existing
      : [...existing, newProviderSessionId];
    adoptedSessions[oldProviderSessionId] = chain;
    return { ...current, adoptedSessions };
  }, options);
  return chain;
}

/** Looks up a previously-recorded lineage chain for `oldProviderSessionId`, or `null` if none was ever recorded. */
export async function getAdoptionLineage(
  oldProviderSessionId: string,
  options: PersistenceOptions = {},
): Promise<string[] | null> {
  const settings = await readSettings(options);
  return settings.adoptedSessions?.[oldProviderSessionId] ?? null;
}
