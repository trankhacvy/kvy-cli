import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_VALUE,
  curatedModelSelectValue,
  DEFAULT_MODEL_VALUE,
  isCuratedModel,
  MODEL_OPTIONS,
} from "../model-meta";

describe("MODEL_OPTIONS", () => {
  it("leads every provider's list with a 'provider default' option using DEFAULT_MODEL_VALUE", () => {
    for (const provider of ["claude-code", "codex"] as const) {
      expect(MODEL_OPTIONS[provider][0]).toEqual({
        value: DEFAULT_MODEL_VALUE,
        label: "Provider default",
      });
    }
  });

  it("never reuses the CUSTOM_MODEL_VALUE sentinel as a real curated option", () => {
    for (const provider of ["claude-code", "codex"] as const) {
      expect(MODEL_OPTIONS[provider].some((o) => o.value === CUSTOM_MODEL_VALUE)).toBe(false);
    }
  });

  it("gives every option a non-empty value (Radix's Select.Item rejects '')", () => {
    for (const provider of ["claude-code", "codex"] as const) {
      for (const option of MODEL_OPTIONS[provider]) {
        expect(option.value.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("isCuratedModel", () => {
  it("treats the empty string (provider default) as curated for every provider", () => {
    expect(isCuratedModel("claude-code", "")).toBe(true);
    expect(isCuratedModel("codex", "")).toBe(true);
  });

  it("is true for a model string in that provider's curated list", () => {
    expect(isCuratedModel("claude-code", "sonnet")).toBe(true);
    expect(isCuratedModel("codex", "gpt-5.1-codex")).toBe(true);
  });

  it("is false for a model belonging only to the other provider", () => {
    expect(isCuratedModel("codex", "sonnet")).toBe(false);
    expect(isCuratedModel("claude-code", "gpt-5.1-codex")).toBe(false);
  });

  it("is false for an arbitrary custom model id", () => {
    expect(isCuratedModel("claude-code", "claude-3-5-sonnet-20241022")).toBe(false);
  });
});

describe("curatedModelSelectValue", () => {
  it("maps the empty string to DEFAULT_MODEL_VALUE", () => {
    expect(curatedModelSelectValue("")).toBe(DEFAULT_MODEL_VALUE);
  });

  it("passes a non-empty model id through unchanged", () => {
    expect(curatedModelSelectValue("opus")).toBe("opus");
  });
});
