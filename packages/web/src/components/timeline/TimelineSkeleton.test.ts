import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelineSkeleton } from "./TimelineSkeleton";

describe("TimelineSkeleton", () => {
  it("marks itself as a busy loading region for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(TimelineSkeleton));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading transcript"');
  });

  it("renders three message-bubble-shaped rows (a label + a body skeleton each)", () => {
    const html = renderToStaticMarkup(createElement(TimelineSkeleton));
    const matches = html.match(/data-slot="skeleton"/g) ?? [];
    expect(matches.length).toBe(6);
  });
});
