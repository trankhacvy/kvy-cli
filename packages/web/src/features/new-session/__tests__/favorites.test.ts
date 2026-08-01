import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "@/lib/__tests__/test-storage.js";
import {
  applyFavoriteDefaults,
  getFavoriteMachineId,
  getFavoriteModel,
  getFavoriteProvider,
  setFavoriteMachineId,
  setFavoriteModel,
  setFavoriteProvider,
} from "../favorites.js";

describe("favorites (no window)", () => {
  it("getters return null and setters are safe no-ops without crashing", () => {
    expect(getFavoriteMachineId()).toBeNull();
    expect(getFavoriteProvider()).toBeNull();
    expect(getFavoriteModel("claude-code")).toBeNull();
    expect(() => setFavoriteMachineId("mach-1")).not.toThrow();
    expect(() => setFavoriteProvider("codex")).not.toThrow();
    expect(() => setFavoriteModel("codex", "gpt-5.1-codex")).not.toThrow();
  });
});

describe("favorites (window.localStorage present)", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("machine: unset by default, round-trips through set, clears via null", () => {
    expect(getFavoriteMachineId()).toBeNull();
    setFavoriteMachineId("mach-laptop");
    expect(getFavoriteMachineId()).toBe("mach-laptop");
    setFavoriteMachineId("mach-server");
    expect(getFavoriteMachineId()).toBe("mach-server");
    setFavoriteMachineId(null);
    expect(getFavoriteMachineId()).toBeNull();
  });

  it("provider: unset by default, round-trips through set, clears via null", () => {
    expect(getFavoriteProvider()).toBeNull();
    setFavoriteProvider("codex");
    expect(getFavoriteProvider()).toBe("codex");
    setFavoriteProvider("claude-code");
    expect(getFavoriteProvider()).toBe("claude-code");
    setFavoriteProvider(null);
    expect(getFavoriteProvider()).toBeNull();
  });

  it("provider: ignores a garbage stored value rather than throwing", () => {
    window.localStorage.setItem("kvy:new-session-favorite-provider", "gemini");
    expect(getFavoriteProvider()).toBeNull();
  });

  it("model: scoped per provider — starring one provider's model doesn't touch the other's", () => {
    setFavoriteModel("claude-code", "opus");
    setFavoriteModel("codex", "gpt-5.1-codex-mini");
    expect(getFavoriteModel("claude-code")).toBe("opus");
    expect(getFavoriteModel("codex")).toBe("gpt-5.1-codex-mini");
  });

  it("model: '' is a valid starred value (starring 'Provider default'), distinct from null (never starred)", () => {
    expect(getFavoriteModel("claude-code")).toBeNull();
    setFavoriteModel("claude-code", "");
    expect(getFavoriteModel("claude-code")).toBe("");
    setFavoriteModel("claude-code", null);
    expect(getFavoriteModel("claude-code")).toBeNull();
  });

  it("model: a later setFavoriteModel overwrites the previous star for that provider", () => {
    setFavoriteModel("codex", "gpt-5.1-codex");
    setFavoriteModel("codex", "gpt-5.1-codex-mini");
    expect(getFavoriteModel("codex")).toBe("gpt-5.1-codex-mini");
  });
});

describe("applyFavoriteDefaults", () => {
  const DEFAULTS = { provider: "claude-code" as const, model: "" };

  it("falls back to defaults untouched when nothing is starred", () => {
    (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
    expect(applyFavoriteDefaults(DEFAULTS)).toEqual(DEFAULTS);
    delete (globalThis as { window?: unknown }).window;
  });

  it("is a safe no-window no-op that returns defaults untouched", () => {
    expect(applyFavoriteDefaults(DEFAULTS)).toEqual(DEFAULTS);
  });

  describe("with window.localStorage present", () => {
    beforeEach(() => {
      (globalThis as { window?: unknown }).window = { localStorage: createMemoryStorage() };
    });

    afterEach(() => {
      delete (globalThis as { window?: unknown }).window;
    });

    it("applies a starred provider, resetting model to that provider's own default", () => {
      setFavoriteProvider("codex");
      expect(applyFavoriteDefaults(DEFAULTS)).toEqual({ provider: "codex", model: "" });
    });

    it("applies a starred model for the (possibly-starred) resolved provider", () => {
      setFavoriteProvider("codex");
      setFavoriteModel("codex", "gpt-5.1-codex-mini");
      expect(applyFavoriteDefaults(DEFAULTS)).toEqual({
        provider: "codex",
        model: "gpt-5.1-codex-mini",
      });
    });

    it("never leaks a starred model from a different provider than the resolved one", () => {
      setFavoriteModel("codex", "gpt-5.1-codex-mini");
      // Provider itself isn't starred, so it resolves to `defaults.provider`
      // ("claude-code") — Codex's starred model must not leak in.
      expect(applyFavoriteDefaults(DEFAULTS)).toEqual({ provider: "claude-code", model: "" });
    });
  });
});
