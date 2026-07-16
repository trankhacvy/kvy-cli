const DEFAULT_TITLE = "Falcon";

/** Insertion-ordered overrides, keyed by a caller-stable id (falcon-prd.md
 * FR-7.9's per-session tab title, `useTabAttention`). A `Map` preserves
 * insertion order, and re-`set`ting an existing key moves it to the end —
 * exactly the "most recently pushed wins" semantics a title stack wants —
 * so `current()` is simply "the last entry, or the default if none". */
const overrides = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Push (or replace) this id's title override, making it the active tab
 * title. Exported for `useTabAttention`'s `useEffect`; not meant to be
 * called during render. */
export function setTitleOverride(id: string, title: string): void {
  overrides.delete(id); // re-insert so this id becomes the most-recent entry
  overrides.set(id, title);
  notify();
}

/** Remove this id's override (its owning component unmounted, or the
 * override no longer applies) — falls back to the next-most-recent
 * override, or `DEFAULT_TITLE` if none remain. */
export function clearTitleOverride(id: string): void {
  if (overrides.delete(id)) notify();
}

/** The currently active tab title — the most recently pushed override, or
 * `DEFAULT_TITLE` when nothing has overridden it. Used by `DocumentTitle`'s
 * `useSyncExternalStore` as both the client and server snapshot getter
 * (the server one just always sees an empty `overrides` map). */
export function getTitleSnapshot(): string {
  if (overrides.size === 0) return DEFAULT_TITLE;
  let last = DEFAULT_TITLE;
  for (const value of overrides.values()) last = value;
  return last;
}

export function subscribeToTitle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
