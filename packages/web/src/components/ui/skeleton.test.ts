import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("renders a pulsing placeholder div with the expected data-slot", () => {
    const html = renderToStaticMarkup(createElement(Skeleton));
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain("animate-pulse");
  });

  it("merges a caller-supplied className alongside the base classes", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { className: "h-4 w-24" }));
    expect(html).toContain("h-4");
    expect(html).toContain("w-24");
    expect(html).toContain("animate-pulse");
  });

  it("passes through arbitrary div props (e.g. aria-hidden)", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { "aria-hidden": true }));
    expect(html).toContain('aria-hidden="true"');
  });
});
