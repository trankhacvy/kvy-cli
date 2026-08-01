import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./__tests__/test-storage.js";
import {
  CODEX_EFFORT_OPTIONS,
  DEFAULT_CODEX_EFFORT,
  getCodexEffort,
  setCodexEffort,
} from "./codex-effort.js";

describe("CODEX_EFFORT_OPTIONS", () => {
  it("offers all five levels in order", () => {
    expect(CODEX_EFFORT_OPTIONS.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("codex effort (no window)", () => {
  it("getter falls back to the default and the setter is a safe no-op without crashing", () => {
    expect(getCodexEffort()).toBe(DEFAULT_CODEX_EFFORT);
    expect(() => setCodexEffort("max")).not.toThrow();
  });
});

describe("codex effort (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to medium when nothing is stored yet", () => {
    expect(getCodexEffort()).toBe(DEFAULT_CODEX_EFFORT);
    expect(DEFAULT_CODEX_EFFORT).toBe("medium");
  });

  it("round-trips a saved preference", () => {
    setCodexEffort("xhigh");
    expect(getCodexEffort()).toBe("xhigh");
    setCodexEffort("low");
    expect(getCodexEffort()).toBe("low");
  });

  it("ignores a garbage stored value rather than throwing", () => {
    window.localStorage.setItem("kvy:codex-effort", "ultra");
    expect(getCodexEffort()).toBe(DEFAULT_CODEX_EFFORT);
  });
});
