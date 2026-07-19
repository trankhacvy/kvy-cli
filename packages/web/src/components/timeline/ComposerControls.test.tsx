import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionControlProvider, useMockSessionControl } from "@/features/session-control";
import { ComposerControls } from "./ComposerControls";

/**
 * Covers the actual `disabled` prop wiring (plan-v2.md W1.4+B15) on the
 * composer footer's session chips — the redistributed ControlBar contents.
 * `ComposerControls` reads `useSessionControl()` (for the mutations'
 * `actions`) and `useMutation` (TanStack Query), so it needs a real
 * `SessionControlProvider` (fed the existing `useMockSessionControl`
 * seam) and a real `QueryClientProvider` above it — both plain context
 * providers, so a `renderToStaticMarkup` render is still enough (no
 * jsdom/@testing-library needed, same style as `lib/markdown.test.ts`).
 * `TooltipProvider` is required because the AI Elements `PromptInputButton`
 * tooltips are Radix `Tooltip`s (the app supplies the provider in
 * `app/providers.tsx`).
 */
function renderControls(props: Partial<React.ComponentProps<typeof ComposerControls>> = {}) {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SessionControlProvider sessionId="sess_1" useControl={useMockSessionControl}>
          <ComposerControls mode="default" controlMode="local" modelChip={null} {...props} />
        </SessionControlProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("ComposerControls disabled wiring", () => {
  it("leaves everything enabled on a live, locally-controlled session (mode read-only, no take-control — W2.4)", () => {
    const html = renderControls();
    expect(html).not.toContain('disabled=""');
    // W2.4 honesty: a PTY/local session hides Take control entirely and shows
    // the mode as a plain read-only label instead of a mutating select.
    expect(html).not.toContain("Take control");
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain("Default");
  });

  it("shows a mutating mode select on a live remote session, plus take-control", () => {
    const html = renderControls({ controlMode: "remote" });
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Take control");
    // Radix `Select.Value` doesn't SSR the selected label, so assert the
    // combobox trigger itself (the mutating affordance) rather than text.
    expect(html).toContain('role="combobox"');
  });

  it("disables mode-select and take-control when disabled in remote control mode", () => {
    const html = renderControls({ disabled: true, controlMode: "remote" });
    // W2.4: Take control is remote-only, so it IS present here.
    expect(html).toContain("Take control");
    const count = (html.match(/disabled=""/g) ?? []).length;
    // select trigger + take-control button.
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("shows the model chip only when a real model id exists (never fabricated)", () => {
    expect(renderControls({ modelChip: null })).not.toContain("claude");
    expect(renderControls({ modelChip: "claude-sonnet-4" })).toContain("claude-sonnet-4");
  });
});
