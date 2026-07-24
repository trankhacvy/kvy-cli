import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingStepUp,
  setStepUpReturn,
  stashPendingStepUp,
  takeStepUpReturn,
} from "../pending-stepup.js";
import { createMemoryStorage } from "./test-storage.js";

describe("pending-stepup: sessionStorage flag", () => {
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { sessionStorage: createMemoryStorage() };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.useRealTimers();
  });

  it("consumePendingStepUp returns null when nothing was stashed", () => {
    expect(consumePendingStepUp()).toBeNull();
  });

  it("round-trips a stashed provider through consumePendingStepUp", () => {
    stashPendingStepUp({ provider: "google" });
    expect(consumePendingStepUp()).toBe("google");
  });

  it("is single-use — a second call returns null", () => {
    stashPendingStepUp({ provider: "github" });
    consumePendingStepUp();
    expect(consumePendingStepUp()).toBeNull();
  });

  it("rejects a mismatched provider (confused-deputy guard) without consuming it for the caller", () => {
    stashPendingStepUp({ provider: "google" });
    // A GitHub callback checking for its own provider must not see this Google stash.
    expect(consumePendingStepUp("github")).toBeNull();
  });

  it("accepts a matching expectProvider", () => {
    stashPendingStepUp({ provider: "github" });
    expect(consumePendingStepUp("github")).toBe("github");
  });

  it("rejects an expired flag past the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stashPendingStepUp({ provider: "google" });
    vi.setSystemTime(6 * 60_000); // past the 5-minute TTL
    expect(consumePendingStepUp()).toBeNull();
  });

  it("rejects malformed JSON in the flag", () => {
    window.sessionStorage.setItem("falcon:pendingStepUp", "{not json");
    expect(consumePendingStepUp()).toBeNull();
  });

  it("a later stash overwrites an earlier, unconsumed one", () => {
    stashPendingStepUp({ provider: "google" });
    stashPendingStepUp({ provider: "github" });
    expect(consumePendingStepUp()).toBe("github");
  });

  it("normal sign-in is not hijacked by an abandoned step-up for a different provider", () => {
    // A Google step-up was stashed from /reset-keys/ and abandoned (no callback ever
    // consumed it). A later, unrelated GitHub sign-in's callback checks its own
    // provider and must proceed normally rather than being diverted into step-up.
    stashPendingStepUp({ provider: "google" });
    expect(consumePendingStepUp("github")).toBeNull();
  });
});

describe("pending-stepup: in-memory return channel", () => {
  afterEach(() => {
    // Drain any leftover state between tests (module-level singleton).
    takeStepUpReturn();
  });

  it("takeStepUpReturn returns null when nothing was set", () => {
    expect(takeStepUpReturn()).toBeNull();
  });

  it("round-trips a return payload through takeStepUpReturn", () => {
    setStepUpReturn({ provider: "google", oauthProof: "proof-1", refreshToken: "rt-1" });
    expect(takeStepUpReturn()).toEqual({
      provider: "google",
      oauthProof: "proof-1",
      refreshToken: "rt-1",
    });
  });

  it("is single-use — a second call returns null", () => {
    setStepUpReturn({ provider: "github", oauthProof: "proof-2", refreshToken: "rt-2" });
    takeStepUpReturn();
    expect(takeStepUpReturn()).toBeNull();
  });
});
