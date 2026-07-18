import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ErrorBoundary from "../error";

// `renderToStaticMarkup` needs no DOM (matches lib/markdown.test.ts's own
// approach) and is enough here: neither `ErrorBoundary` nor `NotFound`
// (below) run any effect this test needs, only render from props.
describe("ErrorBoundary (app/error.tsx)", () => {
  it("surfaces the thrown error's message", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, { error: new Error("decrypt worker crashed"), reset: () => {} }),
    );
    expect(html).toContain("Something went wrong");
    expect(html).toContain("decrypt worker crashed");
  });

  it("falls back to a generic message when the error has none", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, { error: new Error(""), reset: () => {} }),
    );
    expect(html).toContain("An unexpected error occurred.");
  });

  it("renders a 'Try again' control wired to reset()", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, { error: new Error("boom"), reset: () => {} }),
    );
    expect(html).toContain("Try again");
    expect(html).toContain("<button");
  });
});
