import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./Composer";

/**
 * Covers the actual `disabled` prop wiring (plan-v2.md W1.4+B15) — that it
 * really disables the textarea, attach button, and send button, not just
 * that the prop is threaded through in source. Purely presentational (no
 * `SessionControlProvider`/query client needed), so a plain
 * `renderToStaticMarkup` render (no jsdom/@testing-library, same style as
 * `lib/markdown.test.ts`) is enough to inspect the real serialized markup.
 */
function renderComposer(disabled?: boolean) {
  return renderToStaticMarkup(
    <Composer
      onSend={() => {}}
      onAttach={() => {}}
      isSending={false}
      isQueued={false}
      disabled={disabled}
      error={null}
      notice={null}
    />,
  );
}

describe("Composer disabled wiring", () => {
  it("leaves the textarea and attach button enabled by default (the send button is still its own separate empty-text disable)", () => {
    const html = renderComposer(false);
    // Only the send button is disabled here — by `text.trim().length === 0`,
    // not by `disabled`, since there's no text yet on a fresh render.
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain("Send a follow-up…");
    expect(html).not.toContain("This session has ended.");
  });

  it("disables the textarea, attach button, and send button when disabled", () => {
    const html = renderComposer(true);
    // One disabled attribute for each of: attach button, textarea, send button.
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain("This session has ended.");
  });
});
