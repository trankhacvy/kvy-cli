import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeGithubCallback, consumeGoogleCallback } from "../oauth.js";
import { createMemoryStorage } from "./test-storage.js";

const STATE_KEY = "kvy:oauth:state";

/**
 * Covers the CSRF/replay-guard logic in `consumeGoogleCallback` /
 * `consumeGithubCallback` — the security-relevant part of `lib/oauth.ts`
 * (state round-tripped through `sessionStorage`, cleared on first use). The
 * redirect-initiating half (`beginGoogleSignIn`/`beginGithubSignIn`) isn't
 * covered here: it's a bare `window.location.href = ...` side effect with no
 * branching logic worth a stubbed-`window` test.
 */
describe("consumeGoogleCallback", () => {
  let sessionStorage: Storage;

  beforeEach(() => {
    sessionStorage = createMemoryStorage();
    (globalThis as { window?: unknown }).window = { sessionStorage };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("succeeds when state matches and an id_token is present", () => {
    sessionStorage.setItem(STATE_KEY, "state-abc");
    const result = consumeGoogleCallback("#id_token=the-jwt&state=state-abc");
    expect(result).toEqual({ ok: true, value: { idToken: "the-jwt" } });
  });

  it("clears the stashed state after a single use", () => {
    sessionStorage.setItem(STATE_KEY, "state-abc");
    consumeGoogleCallback("#id_token=the-jwt&state=state-abc");
    expect(sessionStorage.getItem(STATE_KEY)).toBeNull();
  });

  it("fails when the returned state does not match the stashed one", () => {
    sessionStorage.setItem(STATE_KEY, "state-abc");
    const result = consumeGoogleCallback("#id_token=the-jwt&state=wrong-state");
    expect(result.ok).toBe(false);
  });

  it("fails when no state was ever stashed (e.g. a replayed/bookmarked callback URL)", () => {
    const result = consumeGoogleCallback("#id_token=the-jwt&state=state-abc");
    expect(result.ok).toBe(false);
  });

  it("surfaces the provider's error param instead of a generic message", () => {
    sessionStorage.setItem(STATE_KEY, "state-abc");
    const result = consumeGoogleCallback("#error=access_denied&state=state-abc");
    expect(result).toEqual({
      ok: false,
      error: "Google sign-in was cancelled or failed (access_denied).",
    });
  });

  it("fails when state matches but no id_token is present", () => {
    sessionStorage.setItem(STATE_KEY, "state-abc");
    const result = consumeGoogleCallback("#state=state-abc");
    expect(result.ok).toBe(false);
  });

  it("handles a hash without its leading '#'", () => {
    sessionStorage.setItem(STATE_KEY, "state-abc");
    const result = consumeGoogleCallback("id_token=the-jwt&state=state-abc");
    expect(result).toEqual({ ok: true, value: { idToken: "the-jwt" } });
  });
});

describe("consumeGithubCallback", () => {
  let sessionStorage: Storage;

  beforeEach(() => {
    sessionStorage = createMemoryStorage();
    (globalThis as { window?: unknown }).window = {
      sessionStorage,
      location: { origin: "https://app.kvy.dev" },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("succeeds when state matches, returning the code and this provider's redirect URI", () => {
    sessionStorage.setItem(STATE_KEY, "state-xyz");
    const result = consumeGithubCallback("?code=abc123&state=state-xyz");
    expect(result).toEqual({
      ok: true,
      value: { code: "abc123", redirectUri: "https://app.kvy.dev/auth/callback/github/" },
    });
  });

  it("fails when state does not match", () => {
    sessionStorage.setItem(STATE_KEY, "state-xyz");
    const result = consumeGithubCallback("?code=abc123&state=wrong");
    expect(result.ok).toBe(false);
  });

  it("surfaces the provider's error param", () => {
    sessionStorage.setItem(STATE_KEY, "state-xyz");
    const result = consumeGithubCallback("?error=access_denied&state=state-xyz");
    expect(result).toEqual({
      ok: false,
      error: "GitHub sign-in was cancelled or failed (access_denied).",
    });
  });

  it("fails when state matches but no code is present", () => {
    sessionStorage.setItem(STATE_KEY, "state-xyz");
    const result = consumeGithubCallback("?state=state-xyz");
    expect(result.ok).toBe(false);
  });
});
