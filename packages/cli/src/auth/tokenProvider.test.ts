import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { createTokenProvider } from "./tokenProvider.js";

function base64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// `decodeTokenClaimsUnverified` never checks the signature (the CLI holds no signing
// secret), so a well-formed but unsigned-looking JWT is sufficient here — this test
// exercises tokenProvider's caching/refresh logic, not JWT verification.
function fakeAccessToken(expiresInSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256" });
  const payload = base64url({
    sub: "acct_1",
    sid: "sess_1",
    ct: "cli-daemon",
    iat: now,
    exp: now + expiresInSeconds,
  });
  return `${header}.${payload}.fake-signature`;
}

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("createTokenProvider", () => {
  it("refreshes on first call and caches the result", async () => {
    const accessToken = fakeAccessToken(3600);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accessToken, refreshToken: "refresh-2" }),
    })) as unknown as typeof fetch;
    const onRotate = vi.fn();

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate,
      logger: silentLogger(),
    });

    const first = await provider.getAccessToken();
    const second = await provider.getAccessToken();

    expect(first).toBe(accessToken);
    expect(second).toBe(accessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second call served from cache
    expect(onRotate).toHaveBeenCalledWith("refresh-2");
  });

  it("refreshes again once the cached token is near expiry", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: fakeAccessToken(call === 1 ? 30 : 3600), // first token near-expiry (< 60s skew)
          refreshToken: `refresh-${call + 1}`,
        }),
      };
    }) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
    });

    await provider.getAccessToken();
    await provider.getAccessToken(); // still within 60s skew of a 30s-lifetime token -> refresh again

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks itself dead on a 401 and stops trying", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
    });

    const result = await provider.getAccessToken();
    expect(result).toBeNull();
    expect(provider.isDead).toBe(true);

    // A second call doesn't even hit the network again.
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves null (never throws) when the refresh response fails schema validation", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      // Missing `refreshToken` entirely — a bare `as RefreshResponse` cast would have
      // silently accepted this; the reviewer nit is that Zod should reject it instead.
      json: async () => ({ accessToken: fakeAccessToken(3600) }),
    })) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
    });

    const result = await provider.getAccessToken();
    expect(result).toBeNull();
    expect(provider.isDead).toBe(false); // a malformed body isn't the same as a definitive 401 rejection
  });

  it("forceRefresh bypasses the cache", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: fakeAccessToken(3600), refreshToken: "refresh-2" }),
    })) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
    });

    await provider.getAccessToken();
    await provider.forceRefresh();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stale-by-one 401: retries once against a newer refresh token already on disk instead of dying permanently", async () => {
    const accessToken = fakeAccessToken(3600);
    const seenRefreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { refreshToken: string };
      seenRefreshTokens.push(body.refreshToken);
      if (body.refreshToken === "refresh-1") {
        // Simulates another process (the daemon) having already rotated this token.
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken, refreshToken: "refresh-3" }),
      };
    }) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
      // Another process already persisted a newer token than the one this instance
      // started with.
      readCurrentRefreshToken: () => "refresh-2",
    });

    const result = await provider.getAccessToken();

    expect(result).toBe(accessToken);
    expect(provider.isDead).toBe(false);
    expect(seenRefreshTokens).toEqual(["refresh-1", "refresh-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stale-by-one mitigation only retries once — a 401 on the retry itself is definitively dead", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
      readCurrentRefreshToken: () => "refresh-2",
    });

    const result = await provider.getAccessToken();

    expect(result).toBeNull();
    expect(provider.isDead).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one original attempt + one stale-retry, no more
  });

  it("a 401 with no newer token on disk (or no readCurrentRefreshToken at all) is still definitively dead", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
      // Same token on disk as the one just rejected — genuinely dead, not stale-by-one.
      readCurrentRefreshToken: () => "refresh-1",
    });

    const result = await provider.getAccessToken();

    expect(result).toBeNull();
    expect(provider.isDead).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no pointless retry against the same token
  });

  it("concurrent getAccessToken calls share one in-flight refresh", async () => {
    let inFlightCount = 0;
    const fetchImpl = vi.fn(async () => {
      inFlightCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: fakeAccessToken(3600), refreshToken: "refresh-2" }),
      };
    }) as unknown as typeof fetch;

    const provider = createTokenProvider({
      backendUrl: "http://localhost:3005",
      refreshToken: "refresh-1",
      fetchImpl,
      now: () => Date.now(),
      onRotate: () => {},
      logger: silentLogger(),
    });

    const [a, b] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
    expect(a).toBe(b);
    expect(inFlightCount).toBe(1);
  });
});
