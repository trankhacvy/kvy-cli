import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  exchangeGithubCode as ExchangeGithubCode,
  verifyGoogleIdToken as VerifyGoogleIdToken,
} from "./oauth.js";
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
    overrides: {
      issuer?: string;
      audience?: string;
      subject?: string;
      ttlSeconds?: number;
      email?: string;
      emailVerified?: boolean;
    } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (overrides.email !== undefined) claims.email = overrides.email;
    if (overrides.emailVerified !== undefined) claims.email_verified = overrides.emailVerified;
    return new SignJWT(claims)
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

    expect(identity).toEqual({
      provider: "google",
      subject: "google-user-123",
      email: null,
      emailVerified: false,
    });
  });

  it("captures a verified email from the token's email/email_verified claims", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken({ email: "alice@example.com", emailVerified: true });

    const identity = await verifyGoogleIdToken(token, jwks);

    expect(identity).toEqual({
      provider: "google",
      subject: "google-user-123",
      email: "alice@example.com",
      emailVerified: true,
    });
  });

  it("stores an unverified email but flags it — never treats it as authoritative", async () => {
    const jwks = createLocalJWKSet({ keys: [publicJwk] } as never);
    const token = await signIdToken({ email: "alice@example.com", emailVerified: false });

    const identity = await verifyGoogleIdToken(token, jwks);

    expect(identity?.email).toBe("alice@example.com");
    expect(identity?.emailVerified).toBe(false);
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
  const noEmails = async () => new Response(JSON.stringify([]), { status: 200 });

  it("returns the identity for a 200 response with a numeric id", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 });

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, noEmails);

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: null,
      emailVerified: false,
    });
  });

  it("returns null for a non-2xx response (invalid/expired token)", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });

    const identity = await verifyGithubAccessToken("gho_badtoken", fetchUser, noEmails);

    expect(identity).toBeNull();
  });

  it("returns null when the response body has no id", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ login: "octocat" }), { status: 200 });

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, noEmails);

    expect(identity).toBeNull();
  });

  it("returns null (not a throw) when the fetch itself rejects", async () => {
    const fetchUser = async () => {
      throw new Error("network down");
    };

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, noEmails);

    expect(identity).toBeNull();
  });

  it("uses the primary verified address from /user/emails when /user's own email is private (null)", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ id: 42, login: "octocat", email: null }), { status: 200 });
    const fetchEmails = async () =>
      new Response(
        JSON.stringify([
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
        ]),
        { status: 200 },
      );

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, fetchEmails);

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: "primary@example.com",
      emailVerified: true,
    });
  });

  it("stores an unverified primary email but flags it — never treats it as authoritative", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ id: 42, login: "octocat", email: null }), { status: 200 });
    const fetchEmails = async () =>
      new Response(
        JSON.stringify([{ email: "unverified@example.com", primary: true, verified: false }]),
        { status: 200 },
      );

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, fetchEmails);

    expect(identity?.email).toBe("unverified@example.com");
    expect(identity?.emailVerified).toBe(false);
  });

  it("degrades to email:null rather than failing the whole sign-in when /user/emails is unreachable", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ id: 42, login: "octocat", email: null }), { status: 200 });
    const fetchEmails = async () => {
      throw new Error("network down");
    };

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, fetchEmails);

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: null,
      emailVerified: false,
    });
  });

  it("degrades to email:null when /user/emails returns a non-2xx (e.g. missing user:email scope on an old grant)", async () => {
    const fetchUser = async () =>
      new Response(JSON.stringify({ id: 42, login: "octocat", email: null }), { status: 200 });
    const fetchEmails = async () =>
      new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });

    const identity = await verifyGithubAccessToken("gho_validtoken", fetchUser, fetchEmails);

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: null,
      emailVerified: false,
    });
  });
});

describe("exchangeGithubCode", () => {
  const ORIGINAL_GITHUB_ENV = {
    GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_SECRET: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  };
  let exchangeGithubCode: typeof ExchangeGithubCode;

  beforeEach(async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "test-github-client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "test-github-client-secret";
    vi.resetModules();
    ({ exchangeGithubCode } = await import("./oauth.js"));
  });

  afterEach(() => {
    process.env.GITHUB_OAUTH_CLIENT_ID = ORIGINAL_GITHUB_ENV.GITHUB_OAUTH_CLIENT_ID;
    process.env.GITHUB_OAUTH_CLIENT_SECRET = ORIGINAL_GITHUB_ENV.GITHUB_OAUTH_CLIENT_SECRET;
  });

  it("returns the access token for a 200 response with a token", async () => {
    const fetchToken = async () =>
      new Response(JSON.stringify({ access_token: "gho_realtoken" }), { status: 200 });

    const token = await exchangeGithubCode(
      "a-code",
      "https://app.falcon.dev/auth/callback/github",
      fetchToken,
    );

    expect(token).toBe("gho_realtoken");
  });

  it("sends client_id, client_secret, code, and redirect_uri to GitHub's token endpoint", async () => {
    let sentBody: unknown;
    const fetchToken = async (body: Record<string, string>) => {
      sentBody = body;
      return new Response(JSON.stringify({ access_token: "gho_realtoken" }), { status: 200 });
    };

    await exchangeGithubCode("a-code", "https://app.falcon.dev/auth/callback/github", fetchToken);

    expect(sentBody).toEqual({
      client_id: "test-github-client-id",
      client_secret: "test-github-client-secret",
      code: "a-code",
      redirect_uri: "https://app.falcon.dev/auth/callback/github",
    });
  });

  it("returns null for a non-2xx response", async () => {
    const fetchToken = async () =>
      new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 401 });

    const token = await exchangeGithubCode(
      "bad-code",
      "https://app.falcon.dev/auth/callback/github",
      fetchToken,
    );

    expect(token).toBeNull();
  });

  it("returns null when the response body has no access_token", async () => {
    const fetchToken = async () =>
      new Response(JSON.stringify({ error: "incorrect_client_credentials" }), { status: 200 });

    const token = await exchangeGithubCode(
      "a-code",
      "https://app.falcon.dev/auth/callback/github",
      fetchToken,
    );

    expect(token).toBeNull();
  });

  it("returns null (not a throw) when the fetch itself rejects", async () => {
    const fetchToken = async () => {
      throw new Error("network down");
    };

    const token = await exchangeGithubCode(
      "a-code",
      "https://app.falcon.dev/auth/callback/github",
      fetchToken,
    );

    expect(token).toBeNull();
  });

  it("fails closed (returns null) when GitHub OAuth credentials aren't configured", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    vi.resetModules();
    const { exchangeGithubCode: freshExchange } = await import("./oauth.js");

    const fetchToken = async () =>
      new Response(JSON.stringify({ access_token: "gho_realtoken" }), { status: 200 });

    const token = await freshExchange(
      "a-code",
      "https://app.falcon.dev/auth/callback/github",
      fetchToken,
    );

    expect(token).toBeNull();
  });
});

describe("defaultOAuthVerifier — dev provider (FALCON_DEV_AUTH bypass)", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("fails closed (returns null) when FALCON_DEV_AUTH isn't set, same as an unconfigured real provider", async () => {
    delete process.env.FALCON_DEV_AUTH;
    vi.resetModules();
    const { defaultOAuthVerifier } = await import("./oauth.js");

    expect(await defaultOAuthVerifier.verify("dev", "anything")).toBeNull();
  });

  it("returns a dev identity bound to the given proof when FALCON_DEV_AUTH=1", async () => {
    process.env = { ...ORIGINAL_ENV, FALCON_DEV_AUTH: "1" };
    vi.resetModules();
    const { defaultOAuthVerifier } = await import("./oauth.js");

    expect(await defaultOAuthVerifier.verify("dev", "some-proof")).toEqual({
      provider: "dev",
      subject: "some-proof",
      email: null,
      emailVerified: false,
    });
  });
});
