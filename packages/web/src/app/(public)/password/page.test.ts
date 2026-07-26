import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `page.tsx` can't be rendered directly under this package's `environment: "node"` vitest
 * config: it's a full page component using `next/navigation`'s `useRouter` — same
 * source-text technique `signin/page.test.ts` uses for similarly hook-heavy JSX.
 *
 * auth-ux-overhaul-fix-plan.md Fix 8: `/password/` used to default to `"signup"`
 * unconditionally, so a returning user finishing a CLI pairing continuation landed on the
 * key-protection question instead of being signed in. Rev 1 of the fix proposed reading
 * `peekPendingPair()` from a `useState` lazy initialiser and was wrong — that helper
 * dereferences `window.sessionStorage` with no `typeof window` guard, and an initialiser
 * runs during the static-export prerender where there is no `window`, which would have
 * broken `next build`. The negative assertion below is the one that matters.
 */
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./page.tsx"),
  "utf-8",
);

describe("password/page.tsx", () => {
  it("reads peekPendingPair() inside a useEffect, not inside the useState<Mode> initialiser", () => {
    expect(pageSource).toContain("peekPendingPair()");
    const useStateIndex = pageSource.indexOf('useState<Mode>("signup")');
    expect(useStateIndex).toBeGreaterThan(-1);
    // The negative assertion: the mode's own useState call must not itself invoke
    // peekPendingPair (that would run during the static-export prerender, where
    // `window` doesn't exist, and break `next build`).
    const useStateLine = pageSource.slice(useStateIndex, useStateIndex + 40);
    expect(useStateLine).not.toContain("peekPendingPair");

    const effectIndex = pageSource.indexOf("useEffect(() => {\n    if (peekPendingPair())");
    expect(effectIndex).toBeGreaterThan(-1);
  });

  it("defaults to sign-in mode (not sign-up) when a pairing is pending", () => {
    const effectIndex = pageSource.indexOf("if (peekPendingPair())");
    expect(effectIndex).toBeGreaterThan(-1);
    const effectBody = pageSource.slice(effectIndex, effectIndex + 200);
    expect(effectBody).toContain('setMode("signin")');
  });

  it("shows the shared pending-pair heading, not a generic one, on a pairing continuation", () => {
    expect(pageSource).toContain("copy.signin.titleWithPendingPair");
  });
});
