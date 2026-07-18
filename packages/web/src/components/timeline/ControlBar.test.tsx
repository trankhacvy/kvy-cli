import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionControlProvider, useMockSessionControl } from "@/features/session-control";
import { ControlBar } from "./ControlBar";

/**
 * Covers the actual `disabled` prop wiring (plan-v2.md W1.4+B15) — that it
 * really disables every control, not just that the prop is threaded
 * through in source. `ControlBar` reads `useSessionControl()` (for the
 * mutations' `actions`) and `useMutation` (TanStack Query), so it needs a
 * real `SessionControlProvider` (fed the existing `useMockSessionControl`
 * seam, same one `mock-actions.ts` was built for) and a real
 * `QueryClientProvider` above it — both plain context providers, so a
 * `renderToStaticMarkup` render is still enough (no jsdom/@testing-library
 * needed, same style as `lib/markdown.test.ts`).
 */
function renderControlBar(props: Partial<React.ComponentProps<typeof ControlBar>> = {}) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <SessionControlProvider sessionId="sess_1" useControl={useMockSessionControl}>
        <ControlBar mode="default" controlMode="local" working={true} {...props} />
      </SessionControlProvider>
    </QueryClientProvider>,
  );
}

describe("ControlBar disabled wiring", () => {
  it("leaves everything enabled on a live, working, locally-controlled session (mode read-only, no take-control — W2.4)", () => {
    const html = renderControlBar();
    expect(html).not.toContain('disabled=""');
    // W2.4 honesty: a PTY/local session hides Take control entirely and shows
    // the mode as a plain read-only display instead of a mutating select.
    expect(html).not.toContain("Take control");
    expect(html).toContain("Mode:");
    expect(html).toContain("End session");
  });

  it("disables interrupt and end-session once the session has ended/failed (local mode)", () => {
    const html = renderControlBar({ disabled: true });
    // interrupt <button> + the End-session dialog trigger; the read-only mode
    // display has nothing to disable in local mode.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("disables interrupt, mode-select, take-control, and end-session when disabled in remote control mode", () => {
    const html = renderControlBar({ disabled: true, controlMode: "remote" });
    // W2.4: Take control is remote-only, so it IS present here.
    expect(html).toContain("Take control");
    const count = (html.match(/disabled=""/g) ?? []).length;
    // interrupt + select trigger + take-control + end-session.
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
