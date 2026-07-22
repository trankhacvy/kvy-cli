/**
 * Pure query-shape helper for `useGitPanel`'s `git.diff` query
 * (docs/features/git-write-actions.md — "Compare against any ref").
 * Extracted from `use-git-panel.ts` so the `selectedPath`/`compareRef` →
 * `fetchDiff` options mapping is unit-testable without a DOM: this
 * package's vitest config runs under `environment: "node"` with no
 * jsdom/`@testing-library/react` wired up (see `use-session-lifecycle.test.ts`'s
 * own note on why hook logic here lives in plain functions, not
 * interactive re-renders), so `use-git-panel.ts` itself stays a thin
 * `useQuery`/`useMutation` wiring layer over functions like this one.
 */
export interface DiffFetchOptions {
  path?: string;
  baseRef?: string;
}

/**
 * `selectedPath: null` means "diff every changed file" (no `path`).
 * `compareRef: null` means "use the workspace's configured base ref" (no
 * `baseRef` override — `gitDiff.ts`'s `resolveConfiguredBaseRef` fallback
 * applies daemon-side); any non-null `compareRef`, including `"HEAD"`, is
 * passed straight through as an explicit override.
 */
export function buildDiffFetchOptions(
  selectedPath: string | null,
  compareRef: string | null,
): DiffFetchOptions {
  const options: DiffFetchOptions = {};
  if (selectedPath) options.path = selectedPath;
  if (compareRef) options.baseRef = compareRef;
  return options;
}
