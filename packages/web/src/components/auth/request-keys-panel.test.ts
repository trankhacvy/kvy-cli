import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `RequestKeysPanel` can't be rendered directly under this package's `environment: "node"`
 * vitest config (no DOM) — same source-text technique `signin/page.test.ts` and
 * `password/page.test.ts` use for similarly hook-heavy JSX.
 *
 * auth-ux-overhaul-fix-plan.md Fix 9: the panel's `starting` phase used to render nothing
 * at all between mount and the first `createKeyRequest`/`listDeviceSessions` round trip —
 * the blank first paint is the part most likely to be silently reverted, hence the
 * dedicated assertion below.
 */
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./request-keys-panel.tsx"),
  "utf-8",
);

describe("request-keys-panel.tsx", () => {
  it('renders a real "starting" phase instead of a blank first paint', () => {
    expect(source).toContain('phase.kind === "starting"');
    const startingIndex = source.indexOf('phase.kind === "starting"');
    const startingBlock = source.slice(startingIndex, startingIndex + 300);
    expect(startingBlock).toContain("copy.keys.needKeysStarting");
  });

  it("renders the mismatch warning alongside the verification code", () => {
    expect(source).toContain("codeMismatchRequester");
  });

  it("pulls the 'no other devices' hint through copy.ts, not an inline JSX string", () => {
    expect(source).toContain("copy.keys.noOtherDevicesHint(");
    expect(source).not.toContain("<code");
  });

  // auth-ux-overhaul-fix-plan.md Fix 10 Part B: an optional `context` line names what
  // happens after the keys land (e.g. which machine `/pair/`'s detour is about to resume
  // connecting) — rendered only when given, so the other two call sites (`password/page.tsx`,
  // `require-auth.tsx`) that pass nothing are unaffected.
  it("accepts an optional context prop and renders it conditionally", () => {
    expect(source).toContain("context?: string");
    expect(source).toContain("{context && ");
  });

  it("never adds context to an effect's dependency array (would re-mint a key request every render)", () => {
    const startEffectIndex = source.indexOf("const start = useCallback(");
    expect(startEffectIndex).toBeGreaterThan(-1);
    const depsIndex = source.indexOf("[bridge],", startEffectIndex);
    expect(depsIndex).toBeGreaterThan(-1);
  });
});
