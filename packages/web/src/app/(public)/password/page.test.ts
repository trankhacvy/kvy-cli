import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-text technique: the client component uses `next/navigation`'s `useRouter` and can't
// render in this package's `environment: "node"` vitest config. `page.tsx` is now a thin
// server wrapper that calls `notFound()` in production; the actual component is in
// `password-page.tsx`.
const pageSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./password-page.tsx"),
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
