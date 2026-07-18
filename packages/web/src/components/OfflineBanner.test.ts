import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConnectivityState } from "@/lib/use-connectivity";

// `OfflineBanner` reads `useConnectivity()` with no injectable seam of its
// own (it always wires the real `apiSocket`) — mocked here purely so this
// test can drive all three connectivity states without a real socket,
// matching `require-auth.test.ts`'s existing next/navigation-mocking
// technique in this same package. The mock reads `connectivity` at call
// time (not at mock-definition time), so mutating it per test is enough —
// no re-import needed between cases.
let connectivity: ConnectivityState = { online: true, wsConnected: true };
vi.mock("@/lib/use-connectivity", () => ({
  useConnectivity: () => connectivity,
}));

const { OfflineBanner } = await import("./OfflineBanner");

describe("OfflineBanner", () => {
  it("renders nothing when online and the WS connection is up", () => {
    connectivity = { online: true, wsConnected: true };
    expect(renderToStaticMarkup(createElement(OfflineBanner))).toBe("");
  });

  it("shows the offline copy when the browser reports no network at all", () => {
    connectivity = { online: false, wsConnected: true };
    const html = renderToStaticMarkup(createElement(OfflineBanner));
    // React escapes the apostrophe as an HTML entity in static markup, so
    // match on a stretch of the copy that doesn't contain one.
    expect(html).toContain("offline. Changes will sync once your connection returns.");
    expect(html).toContain('role="status"');
  });

  it("prioritizes the offline copy when both online and the WS connection are down", () => {
    connectivity = { online: false, wsConnected: false };
    const html = renderToStaticMarkup(createElement(OfflineBanner));
    expect(html).toContain("offline. Changes will sync once your connection returns.");
    expect(html).not.toContain("Reconnecting");
  });

  it("shows the reconnecting copy when the browser is online but the WS is down", () => {
    connectivity = { online: true, wsConnected: false };
    const html = renderToStaticMarkup(createElement(OfflineBanner));
    expect(html).toContain("Reconnecting");
    expect(html).not.toContain("You're offline");
  });
});
