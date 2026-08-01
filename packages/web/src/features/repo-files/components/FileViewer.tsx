"use client";

import { useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki";
import { Button } from "@/components/ui/button";
import { VirtualLineList } from "@/components/virtual-line-list";
import { highlightDiffLines, languageForPath } from "@/lib/diffHighlight";
import type { RepoFileContent } from "../types";

function toPlainTokens(content: string): ThemedToken[][] {
  return content.split("\n").map((line) => [{ content: line } as ThemedToken]);
}

/**
 * Highlights every line of `content` in one `highlightDiffLines` call.
 *
 * The dependency list is `[path, content]` — the raw string — NOT a split
 * `lines` array. `content.split("\n")` produces a new array identity on every
 * render, and `setTokens` re-renders this component, so depending on that
 * array made the effect re-run forever: highlight -> setState -> render ->
 * new array -> highlight again, pegging a core for as long as the file
 * stayed open. `lines` is now derived inside the effect (and via `useMemo`
 * for the initial render only).
 */
function useFileTokens(path: string, content: string): ThemedToken[][] {
  const [tokens, setTokens] = useState<ThemedToken[][]>(() => toPlainTokens(content));

  useEffect(() => {
    let cancelled = false;
    const lang = languageForPath(path);

    // Reset to unhighlighted text for the NEW content immediately, so a slow
    // highlight of a big file never leaves the previous file's tokens zipped
    // against this file's lines.
    setTokens(toPlainTokens(content));

    highlightDiffLines(content.split("\n"), lang).then((result) => {
      if (!cancelled) setTokens(result);
    });

    return () => {
      cancelled = true;
    };
  }, [path, content]);

  return tokens;
}

const ROW_HEIGHT = 20;

function FileLineRow({ lineNumber, tokens }: { lineNumber: number; tokens: ThemedToken[] }) {
  return (
    <div className="flex h-full px-2 font-mono text-xs leading-5 hover:bg-muted/20">
      <span className="mr-3 w-10 shrink-0 select-none text-right text-muted-foreground/50">
        {lineNumber}
      </span>
      <span className="whitespace-pre">
        {tokens.length === 0 && " "}
        {tokens.map((token, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: shiki tokens are positional spans of one immutable line of text — the array is rebuilt wholesale on every highlight pass, never reordered in place.
          <span key={i} style={token.color ? { color: token.color } : undefined}>
            {token.content}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * Read-only, syntax-highlighted file viewer with line numbers (docs/
 * competitive-notes-omnara.md #5 "Full repo file browser": "full
 * syntax-highlighted viewer, line numbers"). Shares its shiki tokenizer
 * (`@/lib/diffHighlight.ts`'s `highlightDiffLines`/`languageForPath`) with
 * `UnifiedDiffViewer` rather than duplicating it — a plain file body is
 * just a diff with every line treated as unchanged context, so the same
 * per-line tokenizer applies directly. Never `dangerouslySetInnerHTML`,
 * same rule as `markdown.ts`/`UnifiedDiffViewer.tsx`.
 *
 * Feature 3 Phase 3 (docs/web-ux-improvements-plan.md): lines render through
 * `VirtualLineList` instead of one `<FileLineRow>` per line — a 5,000-line
 * file used to mean ~10^5 DOM nodes. Fixed-height rows mean long lines no
 * longer wrap (`whitespace-pre` + horizontal scroll replaces the old
 * `whitespace-pre-wrap break-all`) — an accepted, visible trade documented
 * in the plan's rollout notes.
 */
export function FileViewer({
  path,
  content,
  onLoadMore,
  isLoadingMore = false,
}: {
  path: string;
  content: RepoFileContent;
  /** Feature 3 Phase 5 (docs/web-ux-improvements-plan.md): fetches the next byte-range page and appends it — omit to fall back to the old static "this file was truncated" notice with no way to see the rest. */
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
}) {
  const inline = content.inline ?? "";
  const lines = useMemo(() => inline.split("\n"), [inline]);
  const tokens = useFileTokens(path, inline);

  if (!content.inline) {
    return <p className="p-4 text-sm text-muted-foreground">No content to show.</p>;
  }

  const shownKb = Math.round(new Blob([inline]).size / 1024);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {content.truncated && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          {onLoadMore ? (
            <>
              <span>Large file: showing the first {shownKb} KB.</span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                disabled={isLoadingMore}
                onClick={onLoadMore}
              >
                {isLoadingMore ? "Loading…" : "Load more"}
              </Button>
            </>
          ) : (
            <span>This file was truncated. It exceeded the size Kvy inlines directly.</span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/70">
        <div className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-xs">
          {path}
        </div>
        <VirtualLineList
          count={lines.length}
          rowHeight={ROW_HEIGHT}
          className="min-h-0 flex-1 bg-muted/10 py-1"
          renderRow={(i) => <FileLineRow lineNumber={i + 1} tokens={tokens[i] ?? []} />}
        />
      </div>
    </div>
  );
}
