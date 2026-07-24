import { RUNNING_SESSION_MODEL_ALIASES } from "@falcon/wire";
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

  it("exposes 1M-context variants for claude-code's Sonnet and Opus, distinct from the base model (docs/competitive-notes-omnara.md #13)", () => {
    const claudeOptions = MODEL_OPTIONS["claude-code"];
    expect(claudeOptions).toContainEqual({ value: "sonnet[1m]", label: "Sonnet (1M)" });
    expect(claudeOptions).toContainEqual({ value: "opus[1m]", label: "Opus (1M)" });
    // Distinct picks, not a modifier on the base entries.
    expect(claudeOptions.some((o) => o.value === "sonnet")).toBe(true);
    expect(claudeOptions.some((o) => o.value === "opus")).toBe(true);
  });

  it("does not add a 1M variant for Haiku (no long-context tier) or for codex (no 1M-context tier)", () => {
    expect(MODEL_OPTIONS["claude-code"].some((o) => o.value === "haiku[1m]")).toBe(false);
    expect(MODEL_OPTIONS.codex.some((o) => o.value.includes("1m"))).toBe(false);
  });

  it("claude-code's non-default aliases exactly match @falcon/wire's RUNNING_SESSION_MODEL_ALIASES (issue #12 — the web running-session model selector reuses these same short names, and the wire enum is the keystroke-injection allowlist enforcing them server/CLI-side)", () => {
    const nonDefaultValues = MODEL_OPTIONS["claude-code"]
      .map((o) => o.value)
      .filter((v) => v !== DEFAULT_MODEL_VALUE)
      .sort();
    expect(nonDefaultValues).toEqual([...RUNNING_SESSION_MODEL_ALIASES].sort());
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

  it("treats the curated 1M-context variants as curated, separate from their base model", () => {
    expect(isCuratedModel("claude-code", "sonnet[1m]")).toBe(true);
    expect(isCuratedModel("claude-code", "opus[1m]")).toBe(true);
    expect(isCuratedModel("codex", "sonnet[1m]")).toBe(false);
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
