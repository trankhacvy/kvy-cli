import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `Providers` wraps every route, public and authenticated alike — see
 * `(protected)/layout.test.ts` for where `OfflineBanner` actually lives now.
 * Source-text assertion (same technique as `signin/page.test.ts`) rather
 * than a render test: this is just confirming the banner was NOT left wired
 * here too, which would silently reintroduce known-issues.md "OfflineBanner
 * shows a misleading 'Reconnecting…' on pages with no connection to
 * reconnect" (it used to live here, unconditionally wrapping public routes
 * where `apiSocket.connect()` is never called).
 */
const providersSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./providers.tsx"),
  "utf-8",
);

describe("app/providers.tsx — OfflineBanner must not be mounted globally here", () => {
  it("does not import OfflineBanner", () => {
    expect(providersSource).not.toMatch(/import\s*\{\s*OfflineBanner\s*\}/);
  });

  it("does not render an <OfflineBanner /> element", () => {
    expect(providersSource).not.toContain("<OfflineBanner");
  });
});
