import { ATTENTION_META, type AttentionState } from "./attention";

const IDLE_COLOR = "#6b7280"; // muted-foreground-ish gray, matches SESSION_STATUS_META's "idle"
const WORKING_COLOR = "#3b82f6"; // matches SESSION_STATUS_META's "working" blue

/**
 * side-effect lives in `use-tab-attention.ts`. Attention always wins over
 * "working": an outstanding permission/question/failure is more urgent than
 * "still going", per `attention.ts`'s own priority rule.
 */
export function computeTabTitle(
  baseTitle: string,
  attention: AttentionState,
  working: boolean,
): string {
  if (attention) return `${ATTENTION_META[attention].glyph} ${baseTitle} · Kvy`;
  if (working) return `● ${baseTitle} · Kvy`;
  return `${baseTitle} · Kvy`;
}

/** Color for the favicon dot — same mapping `computeTabTitle` uses for its
 * glyph, so title and favicon always agree. */
export function faviconColor(attention: AttentionState, working: boolean): string {
  if (attention) return ATTENTION_META[attention].color;
  if (working) return WORKING_COLOR;
  return IDLE_COLOR;
}

/** A solid-color dot favicon as a data URI — no image asset needed, cheap
 * "cheap, high-value web ergonomics"). */
export function faviconDataUri(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
