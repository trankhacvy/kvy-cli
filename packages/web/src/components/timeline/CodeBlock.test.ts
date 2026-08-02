import type { ComponentPropsWithoutRef } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "./CodeBlock";

/** `CodeBlock` uses `useRef`, so (unlike hook-free components elsewhere in this directory)
 * it can't be called directly and inspected as a plain element tree;
 * `renderToStaticMarkup` gives a stable string instead, same technique
 * `lib/markdown.test.ts` uses for the pipeline as a whole. */
describe("CodeBlock", () => {
  it("renders the wrapped `pre` untouched, plus a resting-state CopyButton alongside it", () => {
    const html = renderToStaticMarkup(
      createElement(CodeBlock, null, createElement("code", null, "const x = 1;")),
    );
    expect(html).toContain('class="group/code relative"');
    expect(html).toContain("<pre");
    expect(html).toContain("const x = 1;");
    expect(html).toContain('aria-label="Copy"');
  });

  it("passes arbitrary `pre` props (e.g. rehype-pretty-code's data-language) straight through", () => {
    // rehype-pretty-code's real `pre` props carry `data-*` attributes that
    // `ComponentPropsWithoutRef<"pre">`'s typed HTML attributes don't model
    // — cast at the boundary, same as `rehypeReact`'s own untyped-props
    // handoff into this override.
    const props = { "data-language": "ts", children: "x" } as ComponentPropsWithoutRef<"pre">;
    const html = renderToStaticMarkup(createElement(CodeBlock, props));
    expect(html).toContain('data-language="ts"');
  });
});
