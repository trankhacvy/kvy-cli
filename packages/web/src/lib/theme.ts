export type Theme = "light" | "dark";

/** Falcon's default theme (design §9 stack table: "dark default theme").
 * `layout.tsx`'s pre-hydration script and `use-theme.ts`'s server snapshot
 * both fall back to this when no stored preference exists yet — the two
 * places that need to agree on it without importing each other (the script
 * runs before any bundle loads). */
export const DEFAULT_THEME: Theme = "dark";

/** `localStorage` key for the persisted preference — shared by the
 * pre-hydration script (`layout.tsx`) and `use-theme.ts`'s store so both
 * read/write the exact same slot. */
export const THEME_STORAGE_KEY = "falcon:theme";

/** Narrows an arbitrary stored value (whatever `localStorage.getItem`
 * returned, or `null`) to a valid `Theme` — a missing key, a stale/foreign
 * value, or a future theme this build doesn't know about all fall back to
 * `DEFAULT_THEME` rather than throwing or rendering unstyled. */
export function parseTheme(value: string | null | undefined): Theme {
  return value === "light" || value === "dark" ? value : DEFAULT_THEME;
}

/** The other theme — used by a simple two-state toggle control. */
export function toggleTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}
