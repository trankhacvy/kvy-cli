import { PROVIDER_IDS } from "@kvy/wire";
import { describe, expect, it } from "vitest";
import { PROVIDER_REGISTRY, providerIdForSubcommand } from "./registry.js";

describe("PROVIDER_REGISTRY", () => {
  it("has an entry for every PROVIDER_IDS member", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_REGISTRY[id]).toBeDefined();
      expect(PROVIDER_REGISTRY[id].id).toBe(id);
    }
  });
});

describe("providerIdForSubcommand", () => {
  it("round-trips every registered kvySubcommand back to its ProviderId", () => {
    for (const id of PROVIDER_IDS) {
      const subcommand = PROVIDER_REGISTRY[id].kvySubcommand;
      expect(providerIdForSubcommand(subcommand)).toBe(id);
    }
  });

  it("returns null for an unregistered subcommand", () => {
    expect(providerIdForSubcommand("opencode")).toBeNull();
    expect(providerIdForSubcommand("")).toBeNull();
  });
});
