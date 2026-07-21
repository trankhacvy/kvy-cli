import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveryCodeInput } from "./recovery-code-input";

describe("RecoveryCodeInput", () => {
  it("renders a labeled text field and a disabled submit button when empty", () => {
    const html = renderToStaticMarkup(<RecoveryCodeInput onSubmit={() => {}} />);
    expect(html).toContain('data-testid="recovery-code-input"');
    expect(html).toContain("Restore account");
    // Empty code -> submit disabled.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Restore account/);
  });

  it("renders the submit button (and the field) disabled while pending", () => {
    const html = renderToStaticMarkup(<RecoveryCodeInput onSubmit={() => {}} pending />);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Restore account/);
  });
});
