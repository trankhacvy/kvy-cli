import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PreviewTunnel } from "../types";
import { TunnelFrame } from "./TunnelFrame";

/**
 * `TunnelFrame`'s load-timeout/"refused to embed" fallback needs a real
 * `onLoad` event and a running timer — this package has no jsdom wired up
 * (`GitToolbar.test.tsx`'s own doc comment notes the same constraint), so
 * `renderToStaticMarkup` never fires effects and the component stays in its
 * initial (not-yet-timed-out) state. This is a markup smoke test of that
 * initial render only: the iframe's `src`/`sandbox`, and that Open-in-new-
 * tab/Copy URL stay visible above it.
 */
const TUNNEL: PreviewTunnel = {
  tunnelId: "t1",
  port: 3000,
  url: "https://example.trycloudflare.com",
  status: "active",
  startedAt: 0,
};

describe("TunnelFrame", () => {
  it("renders an iframe pointed at the tunnel URL with a restrictive sandbox", () => {
    const html = renderToStaticMarkup(createElement(TunnelFrame, { tunnel: TUNNEL }));
    expect(html).toContain('src="https://example.trycloudflare.com"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-forms"');
  });

  it("always renders the open-in-new-tab link, even before any timeout fires", () => {
    const html = renderToStaticMarkup(createElement(TunnelFrame, { tunnel: TUNNEL }));
    expect(html).toContain('href="https://example.trycloudflare.com"');
    expect(html).toContain("Open in new tab");
  });

  it("does not render the 'refused to embed' fallback on initial render", () => {
    const html = renderToStaticMarkup(createElement(TunnelFrame, { tunnel: TUNNEL }));
    expect(html).not.toContain("refused to be embedded");
  });
});
