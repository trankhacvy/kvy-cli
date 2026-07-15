import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { verifyGoogleIdToken as VerifyGoogleIdToken } from "./oauth.js";
import { verifyGithubAccessToken } from "./oauth.js";

const ORIGINAL_ENV = { ...process.env };
const CLIENT_ID = "test-google-client-id";
const ISSUER = "https://accounts.google.com";

describe("verifyGoogleIdToken", () => {
  let publicJwk: Record<string, unknown>;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  // `oauth.ts` reads `env.GOOGLE_OAUTH_CLIENT_ID` from the config singleton at call
  // time, but `config.ts` itself parses `process.env` once at *import* time — so a
  // statically-imported `verifyGoogleIdToken` would freeze whatever client id was set
  // (or unset) before this test file's first import ran. Every test below instead does
  // `vi.resetModules()` + a fresh dynamic import *after* setting `process.env`, the
  // same pattern config.test.ts uses.
  let verifyGoogleIdToken: typeof VerifyGoogleIdToken;

  beforeAll(async () => {
    const { publicKey, privateKey: sk } = await generateKeyPair("RS256");
    privateKey = sk;
    publicJwk = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  });

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID };
    vi.resetModules();
    ({ verifyGoogleIdToken } = await import("./oauth.js"));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function signIdToken(
    overrides: { issuer?: string; audience?: string; subject?: string; ttlSeconds?: number } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? CLIENT_ID)
      .setSubject(overrides.subject ?? "google-user-123")
      .setIssuedAt(now)
      .setExpirationTime(now + (overrides.ttlSeconds ?? 3600))
      .sign(privateKey);
  }

  it("returns the identity for a validly-signed token with matching issuer/audience", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken();

    const identity = await verifyGoogleIdToken(token, jwks);

    expect(identity).toEqual({ provider: "google", subject: "google-user-123" });
  });

  it("returns null when the token's audience doesn't match GOOGLE_OAUTH_CLIENT_ID", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken({ audience: "some-other-client-id" });

    const identity = await verifyGoogleIdToken(token, jwks);

    expect(identity).toBeNull();
  });

  it("returns null when the token's issuer isn't Google", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken({ issuer: "https://evil.example.com" });

    const identity = await verifyGoogleIdToken(token, jwks);

    expect(identity).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken({ ttlSeconds: -1 });

    const identity = await verifyGoogleIdToken(token, jwks);

    expect(identity).toBeNull();
  });

  it("returns null for a malformed token string rather than throwing", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);

    const identity = await verifyGoogleIdToken("not-a-jwt", jwks);

    expect(identity).toBeNull();
  });

  it("fails closed (returns null) when GOOGLE_OAUTH_CLIENT_ID isn't configured, even for an otherwise-valid token", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    vi.resetModules();
    const { verifyGoogleIdToken: freshVerify } = await import("./oauth.js");

    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken();

    const identity = await freshVerify(token, jwks);

    expect(identity).toBeNull();
  });
});

describe("verifyGithubAccessToken", () => {
  it("returns the identity for a 200 response with a numeric id", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 });

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser);

    expect(identity).toEqual({ provider: "github", subject: "42" });
  });

  it("returns null for a non-2xx response (invalid/expired token)", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });

    const identity = await verifyGithubAccessToken("gho_badtoken", fetchUser);

    expect(identity).toBeNull();
  });

  it("returns null when the response body has no id", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 });

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser);

    expect(identity).toBeNull();
  });

  it("returns null (not a throw) when the fetch itself rejects", async () => {
    const fetchUser = async () => {
      throw new Error("network down");
    };

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser);

    expect(identity).toBeNull();
  });
});
