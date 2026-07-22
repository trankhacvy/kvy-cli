import type { FileMentionEntry } from "./types";

/** Max suggestions surfaced at once — keeps the popover short and each search cheap, even against a source with thousands of entries. */
export const FILE_MENTION_RESULT_LIMIT = 20;

/**
 * Ranks `entries` against `query` with a subsequence ("fuzzy") match: every
 * character of `query` (case-insensitive) must appear in the candidate path
 * in order, though not necessarily contiguously — the same relaxed
 * matching VS Code/Sublime's "Go to File" use, so "cmpsr" still finds
 * "Composer.tsx". Scored higher for contiguous runs, matches right after a
 * "/" (path-segment boundaries), and an exact substring hit; shorter paths
 * break ties. A `query` that doesn't match at all is dropped rather than
 * scored zero. An empty `query` short-circuits to the first `limit` entries
 * unscored — there's nothing to rank against, and "just typed @" should
 * show *something* immediately.
 */
export function filterFileMentions(
  entries: FileMentionEntry[],
  query: string,
  limit = FILE_MENTION_RESULT_LIMIT,
): FileMentionEntry[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return entries.slice(0, limit);

  const scored: { entry: FileMentionEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scorePath(entry.path, trimmed);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length);
  return scored.slice(0, limit).map((s) => s.entry);
}

function scorePath(path: string, query: string): number | null {
  const text = path.toLowerCase();
  const q = query.toLowerCase();

  let textIndex = 0;
  let previousMatch = -1;
  let score = 0;
  for (const char of q) {
    const idx = text.indexOf(char, textIndex);
    if (idx === -1) return null;
    score += 10;
    if (previousMatch !== -1 && idx === previousMatch + 1) score += 8; // contiguous run
    if (idx === 0 || text[idx - 1] === "/") score += 6; // path-segment boundary
    previousMatch = idx;
    textIndex = idx + 1;
  }
  if (text.includes(q)) score += 15; // exact substring bonus
  score -= text.length * 0.05; // slight preference for shorter paths
  return score;
}
