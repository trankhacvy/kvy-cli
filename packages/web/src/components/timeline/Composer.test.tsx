import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Composer } from "./Composer";

/**
 * Covers the actual `disabled` prop wiring — that it
 * really disables the textarea, attach button, and send button, not just
 * that the prop is threaded through in source. Purely presentational (no
 * `SessionControlProvider`/query client needed), so a plain
 * `renderToStaticMarkup` render (no jsdom/@testing-library, same style as
 * `lib/markdown.test.ts`) is enough to inspect the real serialized markup.
 * `TooltipProvider` is required because the AI Elements `PromptInputButton`
 * tooltips are Radix `Tooltip`s (the app supplies the provider in
 * `app/providers.tsx`).
 */
function renderComposer(disabled?: boolean) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Composer
        sessionId="sess_1"
        onSend={() => {}}
        onAttach={() => {}}
        isSending={false}
        isQueued={false}
        cryptoReady={true}
        disabled={disabled}
        error={null}
        notice={null}
      />
    </TooltipProvider>,
  );
}

describe("Composer disabled wiring", () => {
  it("leaves the textarea and attach button enabled by default (the send button is still its own separate empty-text disable)", () => {
    const html = renderComposer(false);
    // Two disabled controls here: the send button (by `text.trim().length === 0`,
    // not by `disabled`, since there's no text yet on a fresh render) and the
    // voice-input mic button — disabled because this vitest config's
    // `environment: "node"` has no `window.SpeechRecognition`, so
    // `useSpeechInput` reports `supported: false` here exactly like it would
    // in a real unsupported browser (Firefox, most non-Chromium browsers).
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Send a follow-up…");
    expect(html).not.toContain("This session has ended.");
    expect(html).toContain('aria-label="Voice input"');
  });

  it("disables the textarea, attach button, and send button when disabled", () => {
    const html = renderComposer(true);
    // One disabled attribute for each of: attach button, textarea, send button —
    // plus the mic button (already unconditionally disabled here by the lack
    // of `window.SpeechRecognition`, same as the default-`disabled` case above).
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).toContain("This session has ended.");
  });
});

/**
 * "@" file-mention popover wiring — a
 * static-markup render can't fire real keyboard/change events (no
 * jsdom/@testing-library here, see this file's own top-of-file note), so
 * the interactive trigger→search→select flow is covered by
 * `features/file-mentions`' pure-logic unit tests instead and was verified
 * end-to-end by hand against a running dev server. This just locks in that
 * a fresh, untouched render never shows the popover.
 */
describe("Composer file-mention popover — default (untriggered) render", () => {
  it("renders no mention listbox before '@' has been typed", () => {
    const html = renderComposer(false);
    expect(html).not.toContain('role="listbox"');
  });
});
