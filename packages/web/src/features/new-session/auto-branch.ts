/**
 * Auto-generated branch name for the New Session wizard's "new branch"
 * mode — a sensible default the user can override, e.g. `wf/20260722-a3f9`.
 *
 * Safety contract the output must satisfy (and does, by construction, since
 * every character comes from a fixed alphanumeric alphabet or a literal
 * `wf/`/`-`): git's `check-ref-format` rules (no spaces, no leading `-`, no
 * `..`, no trailing `/`, ASCII only) and `gitWorktree.ts`'s own
 * `assertSafeBranchName` (no `..` path segments, since this becomes a
 * `.worktrees/<branch>` directory name).
 *
 * Deliberately NOT `@paralleldrive/cuid2` (already a dependency elsewhere in
 * the monorepo, e.g. `live-actions.ts`'s idempotency keys use
 * `crypto.randomUUID()` instead) — `cuid2` isn't itself a web package
 * dependency, and the Web Crypto `randomUUID()` this runs on every modern
 * browser already gives a collision-resistant suffix with no new
 * dependency.
 */

/** yyyyMMdd in the local timezone — matches the date a user sees when picking this branch. */
function datePart(now: Date): string {
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

/** Four lowercase hex characters sliced off `crypto.randomUUID()` — collision-resistant, no new dependency. */
function suffixPart(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 4).toLowerCase();
}

/** Generates a fresh `wf/<yyyyMMdd>-<4 chars>` branch name, e.g. `wf/20260722-a3f9`. */
export function generateBranchName(now: Date = new Date()): string {
  return `wf/${datePart(now)}-${suffixPart()}`;
}
