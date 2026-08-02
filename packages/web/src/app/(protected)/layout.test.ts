import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `ProtectedLayout` can't be rendered directly under this package's
 * `environment: "node"` vitest config: `RequireAuth` uses `next/navigation`'s
 * `useRouter`, which throws outside an actual App Router context. Asserting
 * against the shipped source text is the same technique `signin/page.test.ts`
 * uses for similarly hook-heavy, non-pulled-out JSX — this just confirms
 * `OfflineBanner` mounts here (and only here — see `providers.test.ts`),
 * inside `RequireAuth` so it never renders on a public route.
 */
const layoutSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./layout.tsx"),
  "utf-8",
);

describe("(protected)/layout.tsx — OfflineBanner wiring", () => {
  it("imports OfflineBanner", () => {
    expect(layoutSource).toContain('import { OfflineBanner } from "@/components/OfflineBanner"');
  });

  it("renders OfflineBanner inside RequireAuth, before AppShell", () => {
    const requireAuthOpenIndex = layoutSource.indexOf("<RequireAuth>");
    const bannerIndex = layoutSource.indexOf("<OfflineBanner");
    const appShellIndex = layoutSource.indexOf("<AppShell>");

    expect(requireAuthOpenIndex).toBeGreaterThan(-1);
    expect(bannerIndex).toBeGreaterThan(-1);
    expect(appShellIndex).toBeGreaterThan(-1);
    expect(requireAuthOpenIndex).toBeLessThan(bannerIndex);
    expect(bannerIndex).toBeLessThan(appShellIndex);
  });
});
