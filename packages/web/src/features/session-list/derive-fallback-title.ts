import type { RenderItem } from "@/sync/reducer";

const MAX_LENGTH = 80;

/** Strips a leading Conductor-style `<system_instruction>...</system_instruction>`
 * wrapper block, if present — the same environment-preamble-as-first-line
 * problem known-issues.md #9 documents for unmanaged sessions'
 * `firstUserText`, applied here up front rather than repeated as a fresh bug
 * on this second surface. */
const SYSTEM_INSTRUCTION_RE = /^\s*<system_instruction>[\s\S]*?<\/system_instruction>\s*/i;

/**
 * A display title for a session with no real one yet (`title ===
 * "(untitled session)"`, `use-decrypted-titles.ts`'s resolved-no-title
 * sentinel) — the first genuine human-authored line, mirroring
 * conductor.build's own "title from the actual ask" convention. Returns
 * `null` (caller keeps the existing placeholder copy) when nothing usable is
 * found: no messages yet, or the only user text is an empty/whitespace-only
 * wrapper remainder.
 */
export function deriveFallbackTitle(items: readonly RenderItem[]): string | null {
  for (const item of items) {
    if (item.kind !== "text" || item.role !== "user" || item.thinking) continue;
    const stripped = item.md.replace(SYSTEM_INSTRUCTION_RE, "").trim();
    if (stripped.length === 0) continue;
    const firstLine = (stripped.split("\n")[0] ?? stripped).trim();
    if (firstLine.length === 0) continue;
    return firstLine.length > MAX_LENGTH
      ? `${firstLine.slice(0, MAX_LENGTH).trimEnd()}…`
      : firstLine;
  }
  return null;
}
