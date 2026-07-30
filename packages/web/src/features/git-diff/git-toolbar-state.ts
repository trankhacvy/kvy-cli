/**
 * Pure state-transition helpers for `GitToolbar` (docs/features/
 * git-write-actions.md Phase 5), kept in their own module so the
 * inline-rename and commit-submit logic is directly unit-testable without
 * mounting the component — same precedent as `features/unmanaged-sessions/
 * take-over-dialog-state.ts` / `features/session-control/perm-card-state.ts`
 * (this package's vitest config has no jsdom/`@testing-library/react`
 * wired up, so a real click/keystroke can't be simulated — see
 * `use-git-panel.test.ts`'s own doc comment on the same constraint).
 */

/**
 * Resolves the inline branch-rename field's submit (Enter/blur): trims
 * `draft`, returning `null` — a no-op, nothing to rename — when it's empty
 * or unchanged from `currentBranch`; otherwise the new branch name to send
 * to `renameBranch`.
 */
export function resolveBranchRenameSubmit(draft: string, currentBranch: string): string | null {
  const trimmed = draft.trim();
  if (trimmed === "" || trimmed === currentBranch) return null;
  return trimmed;
}

/**
 * Resolves the commit box's submit: `null` — the same reason the Commit
 * button stays disabled — when `message` is empty/whitespace-only;
 * otherwise the exact `{message, stageAll}` params to send to `commit`.
 */
export function resolveCommitSubmit(
  message: string,
  stageAll: boolean,
): { message: string; stageAll: boolean } | null {
  const trimmed = message.trim();
  if (trimmed === "") return null;
  return { message: trimmed, stageAll };
}

/**
 * Normalizes the Add-remote dialog's two fields (Feature 1, docs/
 * web-ux-improvements-plan.md) into `setRemote` params, or `null` when the
 * URL is blank (nothing to submit). Trims both; an empty name falls back to
 * `undefined` so the daemon applies its own `"origin"` default rather than
 * this UI hard-coding it in two places.
 */
export function resolveSetRemoteSubmit(
  url: string,
  name: string,
): { url: string; name?: string } | null {
  const trimmedUrl = url.trim();
  if (trimmedUrl === "") return null;
  const trimmedName = name.trim();
  return trimmedName === "" ? { url: trimmedUrl } : { url: trimmedUrl, name: trimmedName };
}
