"use client";

import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki";
import { highlightDiffLines, languageForPath } from "@/lib/diffHighlight";
import { parseUnifiedDiff, type UnifiedDiffFile, type UnifiedDiffLine } from "@/lib/unifiedDiff";
import { cn } from "@/lib/utils";
import type { GitDiffContent } from "../types";

/** Highlights every hunk line of `file` in one `highlightDiffLines` call (correct multi-line grammar tracking, one grammar load instead of one per line) and returns the token row for each hunk-relative line index. */
function useFileTokens(file: UnifiedDiffFile): ThemedToken[][][] {
  const [tokensByHunk, setTokensByHunk] = useState<ThemedToken[][][]>(() =>
    file.hunks.map((hunk) => hunk.lines.map((line) => [{ content: line.content } as ThemedToken])),
  );

  useEffect(() => {
    let cancelled = false;
    const lang = languageForPath(file.path);
    const allLines = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.content));

    highlightDiffLines(allLines, lang).then((flatTokens) => {
      if (cancelled) return;
      let cursor = 0;
      const byHunk = file.hunks.map((hunk) => {
        const slice = flatTokens.slice(cursor, cursor + hunk.lines.length);
        cursor += hunk.lines.length;
        return slice;
      });
      setTokensByHunk(byHunk);
    });

    return () => {
      cancelled = true;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-highlighting keys off `file` itself (a fresh object per parse), not a derived primitive — re-running whenever the parsed diff changes is exactly the intended behavior.
  }, [file]);

  return tokensByHunk;
}

function DiffLineRow({ line, tokens }: { line: UnifiedDiffLine; tokens: ThemedToken[] }) {
  return (
    <div
      className={cn(
        "flex px-2 font-mono text-xs leading-5",
        line.type === "add" && "bg-emerald-500/15",
        line.type === "remove" && "bg-red-500/15",
      )}
    >
      <span className="mr-2 w-8 shrink-0 select-none text-right text-muted-foreground/50">
        {line.oldLine ?? ""}
      </span>
      <span className="mr-2 w-8 shrink-0 select-none text-right text-muted-foreground/50">
        {line.newLine ?? ""}
      </span>
      <span
        className={cn(
          "mr-2 shrink-0 select-none",
          line.type === "add" && "text-emerald-400",
          line.type === "remove" && "text-red-400",
          line.type === "context" && "text-muted-foreground/60",
        )}
      >
        {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
      </span>
      <span className="whitespace-pre-wrap break-all">
        {tokens.length === 0 && " "}
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

function FileDiff({ file }: { file: UnifiedDiffFile }) {
  const tokensByHunk = useFileTokens(file);

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <div className="border-b border-border/70 bg-muted/40 px-3 py-1.5 font-mono text-xs">
        {file.path}
      </div>
      {file.binary ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Binary file — no diff to show.</p>
      ) : (
        <div className="overflow-x-auto bg-muted/10 py-1">
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={hunk.header}>
              <div className="px-2 py-0.5 font-mono text-xs text-muted-foreground/70">
                {hunk.header}
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLineRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: a hunk's lines are a fixed, positional sequence for the lifetime of this parsed diff — re-parses replace the whole `file` object rather than mutating in place.
                  key={lineIndex}
                  line={line}
                  tokens={tokensByHunk[hunkIndex]?.[lineIndex] ?? []}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only unified diff viewer (falcon-prd.md FR-7.7: "per-file unified
 * diff view (... shiki-highlighted)"). Parses `diff.inline` via
 * `lib/unifiedDiff.ts` and renders each file's hunks with shiki syntax
 * highlighting — never through `dangerouslySetInnerHTML` (`lib/
 * diffHighlight.ts`'s own doc comment): every token becomes a real `<span>`.
 */
export function UnifiedDiffViewer({ diff }: { diff: GitDiffContent }) {
  if (!diff.inline || diff.inline.trim() === "") {
    return <p className="p-4 text-sm text-muted-foreground">No differences.</p>;
  }

  const parsed = parseUnifiedDiff(diff.inline);

  if (parsed.files.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No differences.</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {diff.truncated && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          This diff was truncated — it exceeded the size Falcon inlines directly. Narrow it down to
          a single file for the full content.
        </p>
      )}
      {parsed.files.map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}
    </div>
  );
}
