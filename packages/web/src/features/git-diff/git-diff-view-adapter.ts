import type { UnifiedDiffFile, UnifiedDiffHunk } from "@/lib/unifiedDiff";

/**
 * Pure adapter from `lib/unifiedDiff.ts`'s parsed shape to
 * `@git-diff-view/react`'s `DiffView` `data.hunks: string[]` contract —
 * kept as its own
 * module, no React, so the reconstruction is directly unit-testable (this
 * package's vitest has no jsdom, same "pure logic split out of the
 * component" pattern `git-diff-query.ts`/`push-readiness.ts` already use).
 *
 * `@git-diff-view/react` consumes RAW unified-diff hunk text (the README's
 * own `Git Diff Mode` example passes `hunks: string[]` straight from a
 * parsed `git diff` blob) — this re-serializes what `parseUnifiedDiff`
 * already parsed rather than keeping the original raw substring around,
 * so `lib/unifiedDiff.ts` itself needs no second output shape.
 */

/** Re-serializes one parsed hunk back into its raw `@@ ... @@` + prefixed-line text — the exact shape `git diff` itself emits, and what `@git-diff-view/react`'s `hunks: string[]` expects one element per hunk to be. */
export function serializeHunk(hunk: UnifiedDiffHunk): string {
  const lines = hunk.lines.map((line) => {
    const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    return `${prefix}${line.content}`;
  });
  return [hunk.header, ...lines].join("\n");
}

/** Every hunk of `file`, each re-serialized to its own raw-text string, in original order — `[]` for a binary file (no hunks to show). */
export function buildDiffViewHunks(file: UnifiedDiffFile): string[] {
  return file.hunks.map(serializeHunk);
}
