import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeReact from "rehype-react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

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
 * Single theme for now: the app only ever renders `.dark` (layout.tsx — no
 * appearance toggle yet, design §9.2 Settings screen). When that toggle
 * lands, switch `theme` to `{ light: ..., dark: ... }` and add the
 * `--shiki-light`/`--shiki-dark` CSS rehype-pretty-code documents for that
 * mode.
 */
function buildProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypePrettyCode, {
      theme: "github-dark",
      keepBackground: false,
    })
    .use(rehypeReact, { Fragment, jsx, jsxs });
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
