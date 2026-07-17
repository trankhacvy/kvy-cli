import { describe, expect, it } from "vitest";
import { PROVIDER_META, PROVIDER_OPTIONS, shouldShowBetaBanner } from "../provider-meta";

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

describe("shouldShowBetaBanner", () => {
  // Exercises the exact gating expression the options-step picker's banner render uses
  // (`beta && betaNote`), so switching the provider select's on/off behavior is covered by
  // an automated test rather than relying solely on manual/browser verification.
  it("is false for claude-code (non-beta, no note)", () => {
    expect(shouldShowBetaBanner(PROVIDER_META["claude-code"])).toBe(false);
  });

  it("is true for codex (beta with a note)", () => {
    expect(shouldShowBetaBanner(PROVIDER_META.codex)).toBe(true);
  });

  it("is false when beta is true but betaNote is missing", () => {
    expect(shouldShowBetaBanner({ label: "X", beta: true })).toBe(false);
  });

  it("is false when betaNote is set but beta is false", () => {
    expect(shouldShowBetaBanner({ label: "X", beta: false, betaNote: "note" })).toBe(false);
  });
});
