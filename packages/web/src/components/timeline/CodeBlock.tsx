"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useRef } from "react";
import { CopyButton } from "./CopyButton";

/**
 * `rehype-react`'s `pre` override for fenced code blocks (`lib/markdown.ts`,
 * plan-v2.md W4.2 "Copy buttons"). Reads the rendered DOM's own
 * `textContent` at click time rather than re-serializing rehype-pretty-
 * code's per-line/per-token `<span>` tree — the browser's own text layout
 * is the simplest correct source of exactly the characters a person sees
 * (and wants to copy), and it stays correct even if the shiki token
 * structure changes.
 */
export function CodeBlock(props: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);

  return (
    <div className="group/code relative">
      <pre {...props} ref={ref} />
      <CopyButton
        getText={() => ref.current?.textContent ?? ""}
        className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover/code:opacity-100"
      />
    </div>
  );
}
