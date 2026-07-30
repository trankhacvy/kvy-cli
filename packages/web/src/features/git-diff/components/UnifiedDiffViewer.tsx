"use client";

import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { languageForPath } from "@/lib/diffHighlight";
import { parseUnifiedDiff, type UnifiedDiffFile } from "@/lib/unifiedDiff";
import { buildDiffViewHunks } from "../git-diff-view-adapter";
import type { GitDiffContent } from "../types";

function FileDiff({ file, mode }: { file: UnifiedDiffFile; mode: DiffModeEnum }) {
  const lang = languageForPath(file.path);
  const hunks = useMemo(() => buildDiffViewHunks(file), [file]);

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <div className="border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-xs">
        {file.oldPath && file.newPath && file.oldPath !== file.newPath
          ? `${file.oldPath} → ${file.newPath}`
          : file.path}
      </div>
      {file.binary ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Binary file — no diff to show.</p>
      ) : (
        <DiffView
          data={{
            oldFile: { fileName: file.oldPath ?? file.path, fileLang: lang },
            newFile: { fileName: file.newPath ?? file.path, fileLang: lang },
            hunks,
          }}
          diffViewMode={mode}
          diffViewTheme="dark"
          diffViewFontSize={12}
          diffViewHighlight
        />
      )}
    </div>
  );
}

/**
 * Read-only unified diff viewer (falcon-prd.md FR-7.7: "per-file unified
 * diff view (... shiki-highlighted)").
 *
 * Feature 3 Phase 4 (docs/web-ux-improvements-plan.md): renders through
 * `@git-diff-view/react`'s `DiffView` instead of a hand-rolled per-line
 * `<span>` walk — it consumes raw unified-diff hunk text directly
 * (`git-diff-view-adapter.ts`'s `buildDiffViewHunks`, built from
 * `lib/unifiedDiff.ts`'s already-parsed structure — that module and its
 * tests are unchanged, this only replaced the renderer), handles renames
 * and virtualizes long diffs internally. `lib/unifiedDiff.ts`'s own
 * `parseUnifiedDiff` is still what splits a multi-file `git diff` blob
 * into one `DiffView` per file. `DiffView` also supports a split-vs-unified
 * mode natively — driven here by the `mode` prop (`FileViewerColumn.tsx`'s
 * toggle) rather than `DiffView`'s own internal toggle UI, so it matches
 * this app's own header chrome instead of introducing a second one.
 */
export function UnifiedDiffViewer({
  diff,
  mode = DiffModeEnum.Unified,
  onNarrowToFile,
}: {
  diff: GitDiffContent;
  /** `DiffModeEnum.Unified` (default, one column) or `.Split` (side-by-side) — `FileViewerColumn.tsx`'s Split/Unified toggle. */
  mode?: DiffModeEnum;
  /** Feature 3 Phase 5 (docs/web-ux-improvements-plan.md): called with a file's path when the truncation notice's "View this file" action is used — the caller re-fetches `git.diff` scoped to just that file, which the daemon's own 60KB inline budget applies per-file rather than across the whole multi-file diff. */
  onNarrowToFile?: (path: string) => void;
}) {
  // Hooks can't sit below a conditional return, so the parse (previously
  // called inline in the render body, re-running on every parent render)
  // is memoized here first and the early-return checks moved after it.
  const parsed = useMemo(() => parseUnifiedDiff(diff.inline ?? ""), [diff.inline]);

  if (!diff.inline || diff.inline.trim() === "") {
    return <p className="p-4 text-sm text-muted-foreground">No differences.</p>;
  }

  if (parsed.files.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No differences.</p>;
  }

  const firstFile = parsed.files[0];

  return (
    <div className="flex flex-col gap-3 p-3">
      {diff.truncated && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          <span>This diff was truncated — it exceeded the size Falcon inlines directly.</span>
          {onNarrowToFile && firstFile && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => onNarrowToFile(firstFile.path)}
            >
              View {firstFile.path}
            </Button>
          )}
        </div>
      )}
      {parsed.files.map((file) => (
        <FileDiff key={file.path} file={file} mode={mode} />
      ))}
    </div>
  );
}
