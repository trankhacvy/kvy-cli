"use client";

import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki";
import { highlightDiffLines, languageForPath } from "@/lib/diffHighlight";
import type { RepoFileContent } from "../types";

/** Highlights every line of `content` in one `highlightDiffLines` call (correct multi-line grammar tracking, one grammar load instead of one per line) — the same tokenizer `UnifiedDiffViewer` uses, since a plain file body is just a diff with every line treated as unchanged context. */
function useFileTokens(path: string, content: string): ThemedToken[][] {
  const lines = content.split("\n");
  const [tokens, setTokens] = useState<ThemedToken[][]>(() =>
    lines.map((line) => [{ content: line } as ThemedToken]),
  );

  useEffect(() => {
    let cancelled = false;
    const lang = languageForPath(path);

    highlightDiffLines(lines, lang).then((result) => {
      if (!cancelled) setTokens(result);
    });

    return () => {
      cancelled = true;
    };
  }, [path, lines]);

  return tokens;
}

function FileLineRow({ lineNumber, tokens }: { lineNumber: number; tokens: ThemedToken[] }) {
  return (
    <div className="flex px-2 font-mono text-xs leading-5 hover:bg-muted/20">
      <span className="mr-3 w-10 shrink-0 select-none text-right text-muted-foreground/50">
        {lineNumber}
      </span>
      <span className="whitespace-pre-wrap break-all">
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
 */
export function FileViewer({ path, content }: { path: string; content: RepoFileContent }) {
  const inline = content.inline ?? "";
  const lines = inline.split("\n");
  const tokens = useFileTokens(path, inline);

  if (!content.inline) {
    return <p className="p-4 text-sm text-muted-foreground">No content to show.</p>;
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      {content.truncated && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          This file was truncated — it exceeded the size Falcon inlines directly.
        </p>
      )}
      <div className="overflow-hidden rounded-md border border-border/70">
        <div className="border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-xs">
          {path}
        </div>
        <div className="overflow-x-auto bg-muted/10 py-1">
          {lines.map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fetched file's lines are a fixed, positional sequence for the lifetime of this content — a re-fetch replaces the whole `content` object rather than mutating in place.
            <FileLineRow key={i} lineNumber={i + 1} tokens={tokens[i] ?? []} />
          ))}
        </div>
      </div>
    </div>
  );
}
