import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// `useRouter()` throws outside a real Next.js app-router tree — mocked here
// purely so `SessionHeaderActions` can be rendered at all via
// `renderToStaticMarkup`, matching `features/auth/__tests__/require-auth.test.ts`'s
// existing technique in this same package.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { SessionHeaderActions } = await import("./SessionHeaderActions");

function render() {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SessionHeaderActions, { sessionId: "sess-1" }),
    ),
  );
}

describe("SessionHeaderActions", () => {
  it("renders enabled Archive and Delete controls before any mutation has been triggered", () => {
    const html = render();
    expect(html).toContain("Archive");
    expect(html).toContain("Delete");
    // Both buttons' own className statically includes the
    // `disabled:pointer-events-none` Tailwind variant, so a substring check
    // for "disabled" alone would always match — assert on the actual boolean
    // HTML attribute React emits instead (`disabled=""`), which only appears
    // when the `disabled` prop is truthy.
    expect(html).not.toContain('disabled=""');
  });

  it("does not render the delete-confirm dialog's content until it's opened", () => {
    const html = render();
    expect(html).not.toContain("Delete this session?");
    expect(html).not.toContain("Permanently deletes this session");
  });
});
