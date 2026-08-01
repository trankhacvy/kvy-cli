import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileHandoffButton, sessionShareUrl } from "./MobileHandoffDialog";

describe("sessionShareUrl", () => {
  it("joins the origin and session id into the /dashboard/session/<id>/ convention", () => {
    expect(sessionShareUrl("https://app.kvy.example", "abc123")).toBe(
      "https://app.kvy.example/dashboard/session/abc123/",
    );
  });

  it("has no trailing slash sensitivity on the origin (matches window.location.origin's own shape)", () => {
    // `window.location.origin` never has a trailing slash, so this is a
    // documentation-by-test of that assumption rather than a defensive case.
    expect(sessionShareUrl("http://localhost:3000", "s1")).toBe(
      "http://localhost:3000/dashboard/session/s1/",
    );
  });
});

describe("MobileHandoffButton", () => {
  it("renders the trigger button without touching `window` (safe under SSR/static export)", () => {
    // This module isn't rendered inside jsdom here (no `window` global at
    // all in this test file's environment) — if the component read
    // `window.location.origin` unconditionally during render, this would
    // throw instead of rendering.
    const html = renderToStaticMarkup(<MobileHandoffButton sessionId="abc123" />);
    expect(html).toContain("Continue on mobile");
  });

  it("does not render the dialog content (QR code, link) into the initial (closed) markup", () => {
    // The trigger button itself renders a small `lucide-qr-code` icon
    // (also an `<svg>`) — assert on the dialog-content-only signals instead:
    // the encoded session URL text, and Radix's own portal-content marker.
    const html = renderToStaticMarkup(<MobileHandoffButton sessionId="abc123" />);
    expect(html).not.toContain("/dashboard/session/abc123/");
    expect(html).not.toContain('data-slot="dialog-content"');
  });
});
