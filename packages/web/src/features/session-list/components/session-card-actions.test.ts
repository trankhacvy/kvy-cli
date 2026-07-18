import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionCardActions } from "./session-card-actions";

function render(title = "My session") {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionCardActions, { sessionId: "sess-1", title }),
    ),
  );
}

describe("SessionCardActions", () => {
  it("renders accessible archive/delete icon buttons, both enabled before any mutation fires", () => {
    const html = render();
    expect(html).toContain('aria-label="Archive session"');
    expect(html).toContain('aria-label="Delete session"');
    // Same "disabled:" Tailwind-variant-vs-boolean-attribute distinction as
    // `SessionHeaderActions.test.ts` — check the real HTML attribute, not a
    // substring that's always present in the static className.
    expect(html).not.toContain('disabled=""');
  });

  it("does not render the delete-confirm dialog's content until it's opened", () => {
    const html = render();
    expect(html).not.toContain("Permanently deletes this session");
  });

  it("interpolates the session title into the (unopened, but pre-rendered) delete-confirm copy", () => {
    // The Dialog itself is closed by default (Radix skips rendering its
    // content), so this asserts the *component* renders without throwing
    // for a title containing characters that would matter if this were ever
    // built via string concatenation instead of JSX interpolation.
    expect(() => render('Session "with quotes"')).not.toThrow();
  });
});
