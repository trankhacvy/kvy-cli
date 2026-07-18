import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeReact from "rehype-react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { CodeBlock } from "@/components/timeline/CodeBlock";

/**
 * Markdown → React pipeline for assistant/user message text (design §9.1
 * "Markdown via unified/remark + shiki"; plan.md §8.4). A single shared
 * `unified` processor, built lazily and reused for every message — shiki's
 * highlighter setup is the expensive part, not worth repeating per card.
 *
 * `rehype-pretty-code` wraps shiki inside the unified pipeline (it *is* the
 * "unified+shiki" combination the design calls for).
 *
 * This compiles straight to React elements via `rehype-react` rather than to
 * an HTML string — `Markdown.tsx` renders the result directly (`{node}`),
 * never through `dangerouslySetInnerHTML`. `remarkRehype`'s
 * `allowDangerousHtml` is left at its default `false`, so literal HTML
 * inside the markdown source (e.g. a transcript containing `<script>`) is
 * never turned into element nodes in the first place — it's dropped by
 * `remark-rehype` before `rehype-react` ever sees it. Combined with
 * `rehype-react` (which only ever produces real React elements, whose text
 * children React escapes on render, exactly like everywhere else in this
 * app), there is no HTML-injection surface here at all: `md` (Falcon's own
 * decrypted-but-still-adversary-controlled transcript content, design §5.3)
 * can influence *which* elements render, never inject raw markup.
 *
 * Dual shiki theme (plan-v2.md W4.2): `{ light, dark }` makes shiki emit
 * *both* themes' colors per token as `--shiki-light`/`--shiki-dark` CSS
 * custom properties (no literal `color:` fallback — that's shiki's own
 * dual-theme convention, see https://shiki.style/guide/dual-themes) rather
 * than baking one theme's colors in at render time; `globals.css` picks
 * between them with a plain `.dark` selector, same class `use-theme.ts`
 * toggles on `<html>`. `keepBackground: false` (unchanged) means neither
 * theme's background ever renders — markdown code blocks sit on whatever
 * background their container already has.
 *
 * `components: { pre: CodeBlock }` overrides every fenced-code-block `pre`
 * rehype-pretty-code produces with `CodeBlock` (plan-v2.md W4.2 "Copy
 * buttons") — the one seam `rehype-react` exposes for wrapping/augmenting a
 * specific tag, so the copy affordance rides along without a second pass
 * over the tree.
 */
function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypePrettyCode, {
      theme: { light: "github-light", dark: "github-dark" },
      keepBackground: false,
    })
    .use(rehypeReact, { Fragment, jsx, jsxs, components: { pre: CodeBlock } });
}

type MarkdownProcessor = ReturnType<typeof buildProcessor>;
let processor: MarkdownProcessor | undefined;

function getProcessor(): MarkdownProcessor {
  if (!processor) {
    processor = buildProcessor();
  }
  return processor;
}

export async function renderMarkdown(md: string): Promise<ReactNode> {
  const file = await getProcessor().process(md);
  return file.result;
}
