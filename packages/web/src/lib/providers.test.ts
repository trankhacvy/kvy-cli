import { PROVIDER_IDS } from "@falcon/wire";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_VALUE, getProviderMeta, PROVIDER_META } from "./providers";

describe("PROVIDER_META", () => {
  it("has an entry for every PROVIDER_IDS member", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_META[id]).toBeDefined();
      expect(PROVIDER_META[id].id).toBe(id);
    }
  });

  it("every spawnModels list starts with the provider-default sentinel", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_META[id].spawnModels[0]?.value).toBe(DEFAULT_MODEL_VALUE);
    }
  });

  it("codex has no runningSessionModels (no live model-switch support)", () => {
    expect(PROVIDER_META.codex.runningSessionModels).toEqual([]);
  });
});

describe("getProviderMeta", () => {
  it("returns the real metadata for a known provider", () => {
    expect(getProviderMeta("codex")).toBe(PROVIDER_META.codex);
  });

  it("falls back to a generic, non-crashing meta for an unrecognized provider string", () => {
    const meta = getProviderMeta("some-future-agent");
    expect(meta.label).toBe("some-future-agent");
    expect(meta.runningSessionModels).toEqual([]);
    expect(meta.spawnModels).toEqual([{ value: DEFAULT_MODEL_VALUE, label: "Provider default" }]);
  });

  it("falls back to 'Agent' for an empty provider string", () => {
    expect(getProviderMeta("").label).toBe("Agent");
  });
});
