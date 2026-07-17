import { describe, expect, it } from "vitest";
import { ADAPTER_IDS, ADAPTER_MANIFEST } from "./manifest.js";

describe("ADAPTER_MANIFEST", () => {
  it("has an entry for both providers, keyed by their own id", () => {
    expect([...ADAPTER_IDS].sort()).toEqual(["claude-code", "codex"]);
    for (const id of ADAPTER_IDS) {
      expect(ADAPTER_MANIFEST[id].id).toBe(id);
    }
  });

  it("pins an exact version (never a range) for every adapter", () => {
    for (const id of ADAPTER_IDS) {
      const { version } = ADAPTER_MANIFEST[id];
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("pins a well-formed SRI integrity string for every adapter", () => {
    for (const id of ADAPTER_IDS) {
      const { integrity } = ADAPTER_MANIFEST[id];
      expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    }
  });

  it("only ever names scoped npm packages", () => {
    for (const id of ADAPTER_IDS) {
      expect(ADAPTER_MANIFEST[id].packageName).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+$/);
    }
  });
});
