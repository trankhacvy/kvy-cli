import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-text technique: `RequestKeysPanel` can't render under `environment: "node"` vitest
// config (no DOM).
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
