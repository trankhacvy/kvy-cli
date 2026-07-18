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
  it("leaves interrupt, mode-select, and take-control enabled on a live, working, locally-controlled session", () => {
    const html = renderControlBar();
    expect(html).not.toContain("disabled=");
    expect(html).toContain("Take control");
  });

  it("disables interrupt, mode-select, and take-control once the session has ended/failed", () => {
    const html = renderControlBar({ disabled: true });
    // interrupt <button>, mode <select>, take-control <button>.
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("still disables interrupt/mode-select when disabled, even with no take-control button to disable (remote control mode)", () => {
    const html = renderControlBar({ disabled: true, controlMode: "remote" });
    expect(html).not.toContain("Take control");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
