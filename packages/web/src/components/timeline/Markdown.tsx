"use client";

import { type ReactNode, useEffect, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";

/** Content is immutable once a message lands (the reducer never mutates a
 * `TextItem.md` in place — a changed id means a new item), so caching by
 * the exact markdown string for the tab's lifetime is safe and avoids
 * re-running the unified/shiki pipeline on every scroll-triggered remount. */
const nodeCache = new Map<string, ReactNode>();

export function Markdown({ md }: { md: string }) {
  const [node, setNode] = useState<ReactNode | undefined>(() => nodeCache.get(md));

  useEffect(() => {
    const cached = nodeCache.get(md);
    if (cached !== undefined) {
      setNode(cached);
      return;
    }

    let cancelled = false;
    setNode(undefined);

    renderMarkdown(md).then((rendered) => {
      if (cancelled) return;
      nodeCache.set(md, rendered);
      setNode(rendered);
    });

    return () => {
      cancelled = true;
    };
  }, [md]);

  if (node === undefined) {
    // Plain-text fallback while the async unified/shiki pipeline resolves —
    // never blank, never an error state (design §9.1's "never show a
    // loading error", applied to rendering rather than fetching).
    return <p className="whitespace-pre-wrap break-words">{md}</p>;
  }

  // `node` is a real React element tree (`lib/markdown.ts` compiles via
  // `rehype-react`, not to an HTML string) — no `dangerouslySetInnerHTML`
  // anywhere in this pipeline, so there is no HTML-injection surface to
  // reason about here.
  return <div className="markdown-body break-words text-sm leading-relaxed">{node}</div>;
}
