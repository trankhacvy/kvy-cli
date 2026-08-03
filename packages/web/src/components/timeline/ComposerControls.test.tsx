import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionControlProvider, useMockSessionControl } from "@/features/session-control";
import { ComposerControls } from "./ComposerControls";

/**
 * Covers the actual `disabled` prop wiring on the
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
          <ComposerControls
            mode="default"
            controlMode="local"
            modelChip={null}
            provider="claude-code"
            {...props}
          />
        </SessionControlProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("ComposerControls disabled wiring", () => {
  it("leaves everything enabled on a live, locally-controlled session (mode read-only, no take-control)", () => {
    const html = renderControls();
    expect(html).not.toContain('disabled=""');
    // Honesty: a PTY/local session hides Take control entirely and shows
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
    // Take control is remote-only, so it IS present here.
    expect(html).toContain("Take control");
    const count = (html.match(/disabled=""/g) ?? []).length;
    // select trigger + take-control button.
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("for a provider with live model-switch capability, falls back to 'Model unknown' rather than disappearing (issue #12) — the unknown state is transient there", () => {
    const html = renderControls({ modelChip: null });
    expect(html).not.toContain("claude");
    expect(html).toContain("Model unknown");
    expect(renderControls({ modelChip: "claude-sonnet-4" })).toContain("claude-sonnet-4");
  });

  it("never renders a mutating model selector, even with a known model on a local session — read-only chip only (issue #12: setModel has unfixed correctness bugs)", () => {
    const html = renderControls({ modelChip: "Sonnet 5" });
    expect(html).toContain("Sonnet 5");
    // No second combobox beyond none at all — the mode selector is also
    // read-only for a local session by default, so there should be zero.
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain("Change model");
  });
});

describe("ComposerControls per-provider capability gating (Codex: remote mode-switch, no take-control, no model-switch)", () => {
  it("shows a mutating mode select for a remote codex session — its setMode is real over ACP", () => {
    const html = renderControls({ controlMode: "remote", provider: "codex" });
    expect(html).toContain('role="combobox"');
  });

  it("never shows Take control for codex, even on a remote session — no local mode to hand back to", () => {
    const html = renderControls({ controlMode: "remote", provider: "codex" });
    expect(html).not.toContain("Take control");
  });

  it("never shows a mutating model selector for codex — no ACP call for live model switch exists", () => {
    const html = renderControls({
      controlMode: "remote",
      provider: "codex",
      modelChip: "gpt-5.1-codex",
    });
    expect(html).not.toContain("Change model");
  });

  it("hides the model chip entirely for codex when the model is unknown — 'unknown' can never resolve later, so a permanent chip would look broken, not pending", () => {
    const html = renderControls({ controlMode: "remote", provider: "codex", modelChip: null });
    expect(html).not.toContain("Model unknown");
    expect(html).not.toContain("Model");
  });

  it("still shows the model chip for codex once the model IS known (set at session start via --model)", () => {
    const html = renderControls({
      controlMode: "remote",
      provider: "codex",
      modelChip: "gpt-5.1-codex-mini",
    });
    expect(html).toContain("gpt-5.1-codex-mini");
  });
});
