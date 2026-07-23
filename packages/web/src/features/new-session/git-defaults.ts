/**
 * The New Session wizard's global default branch mode (docs/features/
 * worktree-isolation.md Phase 5, Settings → Git,
 * docs/competitive-notes-omnara.md #2) — strict copy of `favorites.ts`'s
 * pattern: a per-device `localStorage` preference that only seeds the
 * wizard's *starting* choice, same "never authoritative, safe to lose"
 * reasoning (design principle #3). SSR-guarded the same way — Next
 * prerenders every route at build time (static export), where `window`
 * doesn't exist.
 *
 * Only the two globally-defaultable modes — `"repo-root"` and
 * `"new-branch"` — are valid stored values. `"existing-branch"` is
 * inherently per-session (there's no sensible "always start on branch X"
 * default), so it's simply never offered as a default here; a fresh wizard
 * seeded with this default can still switch to "existing branch" manually.
 */

import type { BranchMode } from "./wizard-state";

const DEFAULT_BRANCH_MODE_KEY = "falcon:git-default-branch-mode";

/** The subset of `BranchMode` this module can store as a default. */
type DefaultableBranchMode = Extract<BranchMode, "repo-root" | "new-branch">;

function hasLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isDefaultableBranchMode(value: string | null): value is DefaultableBranchMode {
  return value === "repo-root" || value === "new-branch";
}

/** `"repo-root"` when unset, invalid, or `localStorage` is unavailable (SSR) — the safe, no-behavior-change default. */
export function getDefaultBranchMode(): DefaultableBranchMode {
  if (!hasLocalStorage()) return "repo-root";
  const raw = window.localStorage.getItem(DEFAULT_BRANCH_MODE_KEY);
  return isDefaultableBranchMode(raw) ? raw : "repo-root";
}

/** Sets this device's default branch mode for the New Session wizard. */
export function setDefaultBranchMode(mode: DefaultableBranchMode): void {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(DEFAULT_BRANCH_MODE_KEY, mode);
}
