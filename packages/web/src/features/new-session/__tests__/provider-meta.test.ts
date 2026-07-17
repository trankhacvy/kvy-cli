import { describe, expect, it } from "vitest";
import { PROVIDER_META, PROVIDER_OPTIONS } from "../provider-meta";

describe("PROVIDER_META", () => {
  it("marks claude-code as non-beta with no banner note", () => {
    expect(PROVIDER_META["claude-code"].beta).toBe(false);
    expect(PROVIDER_META["claude-code"].betaNote).toBeUndefined();
  });

  it("marks codex as beta with a non-empty banner note", () => {
    expect(PROVIDER_META.codex.beta).toBe(true);
    expect(PROVIDER_META.codex.betaNote).toBeTruthy();
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("lists claude-code before codex, matching each provider's PROVIDER_META entry", () => {
    expect(PROVIDER_OPTIONS.map(([value]) => value)).toEqual(["claude-code", "codex"]);
    for (const [value, meta] of PROVIDER_OPTIONS) {
      expect(meta).toBe(PROVIDER_META[value]);
    }
  });
});
