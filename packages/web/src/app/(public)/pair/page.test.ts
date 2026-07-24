import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `PairPage` can't be rendered directly under this package's `environment: "node"` vitest
 * config (`next/navigation`'s `useRouter` + a real crypto worker) — same source-text technique
 * `app/(public)/signin/page.test.ts` uses for similarly hook-heavy, non-pulled-out JSX.
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

describe("pair/page.tsx — /reset-keys/ wiring (docs/auth-ux-hardening-plan.md item 2d)", () => {
  it("the no-identity branch offers a button to /reset-keys/ alongside its existing paragraph", () => {
    const noIdentityIndex = pageSource.indexOf('bridgeStatus.kind === "no-identity"');
    expect(noIdentityIndex).toBeGreaterThan(-1);
    const block = pageSource.slice(noIdentityIndex, noIdentityIndex + 700);
    expect(block).toContain("This browser has no Falcon key material");
    expect(block).toContain('router.push("/reset-keys/")');
  });
});
