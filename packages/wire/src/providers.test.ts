import { describe, expect, it } from "vitest";
import {
  getProviderCapabilities,
  PROVIDER_CAPABILITIES,
  PROVIDER_IDS,
  ProviderIdSchema,
} from "./providers";

describe("ProviderIdSchema", () => {
  it("accepts every id in PROVIDER_IDS", () => {
    for (const id of PROVIDER_IDS) {
      expect(ProviderIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects an unknown provider string", () => {
    expect(ProviderIdSchema.safeParse("some-future-agent").success).toBe(false);
  });
});

describe("PROVIDER_CAPABILITIES", () => {
  it("has an entry for every PROVIDER_IDS member", () => {
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_CAPABILITIES[id]).toBeDefined();
    }
  });

  it("claude-code supports every capability", () => {
    expect(PROVIDER_CAPABILITIES["claude-code"]).toEqual({
      hasLocalMode: true,
      supportsLiveModeSwitch: true,
      supportsLiveModelSwitch: true,
      supportsTakeControl: true,
      supportsResume: true,
    });
  });

  it("codex has no local mode, no live model switch, no take control — but does support resume (live-verified 2026-07-31 via --continue-from + ACP session/load)", () => {
    expect(PROVIDER_CAPABILITIES.codex).toEqual({
      hasLocalMode: false,
      supportsLiveModeSwitch: true,
      supportsLiveModelSwitch: false,
      supportsTakeControl: false,
      supportsResume: true,
    });
  });
});

describe("getProviderCapabilities", () => {
  it("returns the real capabilities for a known provider", () => {
    expect(getProviderCapabilities("codex")).toEqual(PROVIDER_CAPABILITIES.codex);
  });

  it("falls back to all-false for an unrecognized provider string, never throws", () => {
    expect(getProviderCapabilities("some-future-agent")).toEqual({
      hasLocalMode: false,
      supportsLiveModeSwitch: false,
      supportsLiveModelSwitch: false,
      supportsTakeControl: false,
      supportsResume: false,
    });
    expect(getProviderCapabilities("")).toEqual({
      hasLocalMode: false,
      supportsLiveModeSwitch: false,
      supportsLiveModelSwitch: false,
      supportsTakeControl: false,
      supportsResume: false,
    });
  });
});
