import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QrCodeSvg } from "./QrCodeSvg";

describe("QrCodeSvg", () => {
  it("renders an accessible <svg> with a non-empty path", () => {
    const html = renderToStaticMarkup(<QrCodeSvg value="https://falcon.example/session/abc123/" />);
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain("scan to continue this session on mobile");
    expect(html).toMatch(/<path d="M[^"]+"/);
  });

  it("renders a different path for a different value", () => {
    const a = renderToStaticMarkup(<QrCodeSvg value="https://falcon.example/session/aaaa/" />);
    const b = renderToStaticMarkup(<QrCodeSvg value="https://falcon.example/session/bbbb/" />);
    expect(a).not.toBe(b);
  });

  it("passes className through to the root <svg>", () => {
    const html = renderToStaticMarkup(
      <QrCodeSvg value="https://falcon.example/session/abc123/" className="size-40" />,
    );
    expect(html).toContain('class="size-40"');
  });
});
