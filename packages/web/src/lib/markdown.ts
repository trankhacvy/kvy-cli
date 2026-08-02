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
 * Markdown → React pipeline. A single shared `unified` processor built lazily and
 * reused — shiki highlighter setup is the expensive part.
 *
 * Compiles to React elements via `rehype-react`, never to an HTML string.
 * `remarkRehype`'s `allowDangerousHtml` stays `false` so literal HTML inside
 * markdown (e.g. a transcript containing `<script>`) is dropped before `rehype-react`
 * sees it — there is no HTML-injection surface. Adversary-controlled transcript content
 * can influence which elements render, never inject raw markup.
 *
 * Dual shiki theme `{ light, dark }` emits `--shiki-light`/`--shiki-dark` CSS custom
 * properties per token; `globals.css` picks between them with a `.dark` selector.
 * `keepBackground: false` means code blocks inherit their container's background.
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
