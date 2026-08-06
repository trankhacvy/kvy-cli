export type Theme = "light" | "dark" | "system";

/** Default theme — `layout.tsx`'s pre-hydration script and `use-theme.ts` both fall back
 * to this when no stored preference exists, so they agree without importing each other. */
export const DEFAULT_THEME: Theme = "dark";

/** `localStorage` key for the persisted preference — shared by the
 * pre-hydration script (`layout.tsx`) and `use-theme.ts`'s store so both
 * read/write the exact same slot. */
export const THEME_STORAGE_KEY = "kvy:theme";

/** Narrows an arbitrary stored value (whatever `localStorage.getItem`
 * returned, or `null`) to a valid `Theme` — a missing key, a stale/foreign
 * value, or a future theme this build doesn't know about all fall back to
 * `DEFAULT_THEME` rather than throwing or rendering unstyled. */
export function parseTheme(value: string | null | undefined): Theme {
  return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_THEME;
}

/** Resolves a stored preference to the actual light/dark class to apply —
 * `"system"` reads the OS preference; falls back to dark when `matchMedia`
 * isn't available (SSR / older browsers). */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
