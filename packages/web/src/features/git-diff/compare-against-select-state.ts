/**
 * Pure state-transition helpers for `CompareAgainstSelect`, kept in their
 * own module for the same "directly testable without a DOM" reason as
 * `git-toolbar-state.ts`.
 */

export const WORKSPACE_DEFAULT_VALUE = "__workspace_default__";
export const HEAD_VALUE = "HEAD";
export const CUSTOM_VALUE = "__custom__";

/**
 * Client-side mirror of the daemon's `gitDiff.ts`'s `isSafeRevision` —
 * rejects an empty or `-`-prefixed ref before it ever reaches the wire (a
 * leading `-` could otherwise be parsed as a `git diff` option). A ref that
 * passes this but still doesn't exist server-side just surfaces as a
 * `GitExecError` in the diff error slot, same as any other bad ref — this
 * check is a UX nicety, not the real safety boundary.
 */
export function isSafeCompareRef(ref: string): boolean {
  return ref.trim() !== "" && !ref.startsWith("-");
}

/** The `<Select>`'s own controlled `value` for the current `compareRef`/`customOpen` state. */
export function resolveSelectValue(compareRef: string | null, customOpen: boolean): string {
  if (customOpen) return CUSTOM_VALUE;
  return compareRef ?? WORKSPACE_DEFAULT_VALUE;
}

export type SelectChangeResult = { openCustom: true } | { openCustom: false; ref: string | null };

/** Maps a raw `<Select onValueChange>` value to the state transition it represents. */
export function resolveSelectChange(value: string): SelectChangeResult {
  if (value === CUSTOM_VALUE) return { openCustom: true };
  return { openCustom: false, ref: value === WORKSPACE_DEFAULT_VALUE ? null : value };
}

/** Resolves the free-text custom-ref field's submit: `null` when unsafe/empty (mirrors `isSafeCompareRef`), else the trimmed ref to apply as `compareRef`. */
export function resolveCustomRefSubmit(draft: string): string | null {
  const trimmed = draft.trim();
  if (!isSafeCompareRef(trimmed)) return null;
  return trimmed;
}
