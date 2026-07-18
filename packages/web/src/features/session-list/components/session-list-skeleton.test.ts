import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionListSkeleton } from "./session-list-skeleton";

describe("SessionListSkeleton", () => {
  it("marks itself as a busy loading region for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(SessionListSkeleton));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading sessions"');
  });

  it("renders two workspace-section placeholders, each with two card placeholders", () => {
    const html = renderToStaticMarkup(createElement(SessionListSkeleton));
    const matches = html.match(/data-slot="skeleton"/g) ?? [];
    // 2 sections x (1 heading skeleton + 2 cards x 5 skeletons each) = 2 x 11 = 22
    expect(matches.length).toBe(22);
  });
});
