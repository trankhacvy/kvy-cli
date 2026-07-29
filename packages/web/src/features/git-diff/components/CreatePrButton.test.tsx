import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CreatePrButton } from "./CreatePrButton";

describe("CreatePrButton", () => {
  it("renders the ask-agent label", () => {
    const html = renderToStaticMarkup(createElement(CreatePrButton, { onSend: vi.fn() }));
    expect(html).toContain("Ask agent to open PR");
  });

  it("never calls onSend merely by rendering", () => {
    const onSend = vi.fn();
    renderToStaticMarkup(createElement(CreatePrButton, { onSend }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("respects disabled", () => {
    const html = renderToStaticMarkup(
      createElement(CreatePrButton, { onSend: vi.fn(), disabled: true }),
    );
    expect(html).toContain('disabled=""');
  });
});
