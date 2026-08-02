import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `Providers` wraps every route, public and authenticated alike — see
 * `(protected)/layout.test.ts` for where `OfflineBanner` actually lives.
 * Source-text assertion (same technique as `signin/page.test.ts`) rather
 * than a render test: confirming the banner is NOT wired here, which would
 * cause it to show 'Reconnecting…' on public routes where
 * `apiSocket.connect()` is never called.
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
