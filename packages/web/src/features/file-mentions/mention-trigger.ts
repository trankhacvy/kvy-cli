/**
 * Pure text/cursor logic for the composer's "@" trigger — kept
 * dependency-free of React/DOM so it's directly unit-testable (mirrors
 * `features/new-session/components/directory-step-logic.ts`'s split from
 * its component).
 */
export interface MentionTrigger {
  /** Index of the "@" character itself. */
  start: number;
  /** Cursor index — exclusive end of the query span (`text.slice(start + 1, end)` is the query). */
  end: number;
  /** Text typed after the "@" so far. */
  query: string;
}

/**
 * An "@" at `cursor` opens/keeps a mention active only when it's preceded
 * by start-of-text or whitespace (so an email-like "foo@bar" or a mid-word
 * "@" never triggers) and nothing between it and `cursor` is whitespace
 * (typing a space closes the picker, same as every other "@"/"/" mention
 * UI). Returns `null` when no trigger is active at `cursor`.
 */
export function findMentionTrigger(text: string, cursor: number): MentionTrigger | null {
  if (cursor <= 0 || cursor > text.length) return null;

  for (let i = cursor - 1; i >= 0; i--) {
    const char = text[i];
    if (char === "@") {
      const before = text[i - 1];
      if (before !== undefined && !/\s/.test(before)) return null;
      return { start: i, end: cursor, query: text.slice(i + 1, cursor) };
    }
    if (char !== undefined && /\s/.test(char)) return null;
  }
  return null;
}

/**
 * Replaces the trigger's "@query" span with "@<path> " (trailing space so
 * typing continues past the mention rather than extending it), returning
 * the new text and where the caret should land afterward.
 */
export function applyMentionSelection(
  text: string,
  trigger: MentionTrigger,
  path: string,
): { text: string; cursor: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const inserted = `@${path} `;
  return { text: before + inserted + after, cursor: before.length + inserted.length };
}
