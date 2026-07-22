/**
 * "@" file-mention autocomplete (docs/competitive-notes-omnara.md #17) — the
 * composer's searchable file picker. Mirrors `features/git-diff`'s
 * `GitDiffActions`/`UseGitDiffActions` seam: a small typed surface
 * (`FileMentionActions`) the UI depends on, swappable between a static
 * `mock-source.ts` default (used until a screen wires in a live
 * `apiSocket`/crypto client + machine RPC — same not-yet-wired state as
 * every other `features/*` seam in this app) and `live-actions.ts`'s real
 * `fs.list`-backed implementation.
 */

export interface FileMentionEntry {
  /** Repo-relative path (e.g. `"packages/web/src/features/file-mentions/types.ts"`) — inserted verbatim after the "@" when chosen. */
  path: string;
}

export interface FileMentionActions {
  /**
   * Resolves to files matching `query` (fuzzy, case-insensitive subsequence
   * match — see `fuzzy.ts`), best match first, capped to a small page. An
   * empty `query` (just-typed "@") returns a default/most-relevant set
   * rather than every file. Throws only on a genuine transport failure —
   * callers treat that as "no suggestions right now", never an error
   * banner (the composer itself must never block on this).
   */
  search(query: string): Promise<FileMentionEntry[]>;
}
