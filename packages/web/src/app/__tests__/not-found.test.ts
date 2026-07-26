import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotFound from "../not-found";

describe("NotFound (app/not-found.tsx)", () => {
  it("renders a 404 message and a way back to the app", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Back to sessions");
  });
});
