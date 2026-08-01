/**
 * Codex "Effort" setting (docs/competitive-notes-omnara.md #14): a persisted
 * global default for Codex's reasoning effort level (Low / Medium / High /
 * Extra High / Max), configured in Settings → Agent and independent of model
 * choice. `localStorage` is the right store here — same reasoning as
 * `features/new-session/favorites.ts`: a per-device preference, never
 * authoritative, safe to lose (design principle #3). Guarded for SSR/build
 * time the same way `favorites.ts`/`use-theme.ts` are — Next prerenders
 * these routes at build time (static export), where `window` doesn't exist.
 */

export type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CodexEffortOption {
  value: CodexEffort;
  label: string;
}

export const CODEX_EFFORT_OPTIONS: CodexEffortOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

/** Kvy's default effort level when no preference has ever been saved. */
export const DEFAULT_CODEX_EFFORT: CodexEffort = "medium";

const CODEX_EFFORT_STORAGE_KEY = "kvy:codex-effort";

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/** Narrows an arbitrary stored value (whatever `localStorage.getItem`
 * returned, or `null`) to a valid `CodexEffort` — a missing key, a
 * stale/foreign value, or a future level this build doesn't know about all
 * fall back to `DEFAULT_CODEX_EFFORT` rather than throwing. */
function isCodexEffort(value: string | null): value is CodexEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

/** The persisted global default, or `DEFAULT_CODEX_EFFORT` when unset,
 * foreign, or there's no `window` (SSR/build). */
export function getCodexEffort(): CodexEffort {
  if (!hasLocalStorage()) return DEFAULT_CODEX_EFFORT;
  const raw = window.localStorage.getItem(CODEX_EFFORT_STORAGE_KEY);
  return isCodexEffort(raw) ? raw : DEFAULT_CODEX_EFFORT;
}

/** Persists `effort` as the new global default. Best-effort/no-op without a
 * `window` (SSR/build) — mirrors `favorites.ts`'s setters. */
export function setCodexEffort(effort: CodexEffort): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(CODEX_EFFORT_STORAGE_KEY, effort);
}
