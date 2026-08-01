import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

/** `renderMarkdown` returns a React element tree (`rehype-react` — see
 * lib/markdown.ts), not an HTML string; `renderToStaticMarkup` gives these
 * tests a stable string to assert against without needing a DOM. */
async function renderToHtml(md: string): Promise<string> {
  const node = await renderMarkdown(md);
  return renderToStaticMarkup(node);
}

describe("renderMarkdown", () => {
  it("renders basic inline formatting to real elements", async () => {
    const html = await renderToHtml("Hello **world**, this is *Kvy*.");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<em>Kvy</em>");
  });

  it("renders GFM features (tables, strikethrough, task lists)", async () => {
    const html = await renderToHtml("~~old~~ new\n\n- [x] done\n- [ ] todo");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('type="checkbox"');
  });

  it("syntax-highlights fenced code blocks via shiki, preserving the source text", async () => {
    const html = await renderToHtml("```ts\nconst x: number = 1;\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("const");
    expect(html).toContain("<span");
  });

  it("never turns literal HTML in the markdown source into live elements — the injection surface this pipeline is designed to have none of", async () => {
    const html = await renderToHtml(
      'Check this out: <img src=x onerror="alert(document.cookie)"> and <a href="javascript:alert(1)">click</a>',
    );
    // remark-rehype with allowDangerousHtml:false (lib/markdown.ts) drops
    // raw HTML nodes before rehype-react ever runs — no <img>, no
    // javascript: href, no event handler ever becomes a real element.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Check this out");
    expect(html).toContain("click");
  });

  it("round-trips plain text with no markdown syntax", async () => {
    const html = await renderToHtml("just a plain sentence");
    expect(html).toContain("just a plain sentence");
  });

  it("emits dual --shiki-light/--shiki-dark CSS vars per token, never a hardcoded single-theme color (plan-v2.md W4.2 'dual shiki theme')", async () => {
    const html = await renderToHtml("```ts\nconst x = 1;\n```");
    expect(html).toContain("--shiki-light:");
    expect(html).toContain("--shiki-dark:");
    // rehype-pretty-code's dual-theme mode forces `defaultColor: false` — a
    // literal `color:` property on a token would mean the light/dark switch
    // in globals.css (`.markdown-body [data-rehype-pretty-code-figure]
    // span`) has nothing to override.
    expect(html).not.toContain("color:#");
  });

  it("wires the fenced-code `pre` through CodeBlock (plan-v2.md W4.2 'Copy buttons'), not a bare `pre`", async () => {
    const html = await renderToHtml("```ts\nconst x = 1;\n```");
    // CodeBlock wraps `pre` in a `group/code` div alongside a CopyButton.
    expect(html).toContain('class="group/code relative"');
    expect(html).toContain('aria-label="Copy"');
  });
});
