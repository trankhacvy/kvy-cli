import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  exchangeGithubCode as ExchangeGithubCode,
  exchangeGoogleCode as ExchangeGoogleCode,
  verifyGithubAccessToken as VerifyGithubAccessToken,
  verifyGoogleIdToken as VerifyGoogleIdToken,
} from "./oauth.js";

const ORIGINAL_ENV = { ...process.env };
const CLIENT_ID = "test-google-client-id";
const ISSUER = "https://accounts.google.com";
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

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
    // Better Auth's own `verifyGoogleIdToken` fetches Google's JWKS itself (no
    // injectable jwks param) — stub the network call it makes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === GOOGLE_CERTS_URL) return jsonResponse({ keys: [publicJwk] });
        throw new Error(`unexpected fetch in verifyGoogleIdToken test: ${String(input)}`);
      }),
    );
  });

  async function signIdToken(
    overrides: {
      issuer?: string;
      audience?: string;
      subject?: string;
      ttlSeconds?: number;
      email?: string;
      emailVerified?: boolean;
      picture?: string;
    } = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (overrides.email !== undefined) claims.email = overrides.email;
    if (overrides.emailVerified !== undefined) claims.email_verified = overrides.emailVerified;
    if (overrides.picture !== undefined) claims.picture = overrides.picture;
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
    const token = await signIdToken();

    const identity = await verifyGoogleIdToken(token);

    expect(identity).toEqual({
      provider: "google",
      subject: "google-user-123",
      email: null,
      emailVerified: false,
      image: null,
    });
  });

  it("captures a verified email from the token's email/email_verified claims", async () => {
    const token = await signIdToken({ email: "alice@example.com", emailVerified: true });

    const identity = await verifyGoogleIdToken(token);

    expect(identity).toEqual({
      provider: "google",
      subject: "google-user-123",
      email: "alice@example.com",
      emailVerified: true,
      image: null,
    });
  });

  it("stores an unverified email but flags it — never treats it as authoritative", async () => {
    const token = await signIdToken({ email: "alice@example.com", emailVerified: false });

    const identity = await verifyGoogleIdToken(token);

    expect(identity?.email).toBe("alice@example.com");
    expect(identity?.emailVerified).toBe(false);
  });

  it("captures the avatar URL from the token's picture claim", async () => {
    const token = await signIdToken({ picture: "https://example.com/avatar.png" });

    const identity = await verifyGoogleIdToken(token);

    expect(identity?.image).toBe("https://example.com/avatar.png");
  });

  it("returns null when the token's audience doesn't match GOOGLE_OAUTH_CLIENT_ID", async () => {
    const token = await signIdToken({ audience: "some-other-client-id" });

    const identity = await verifyGoogleIdToken(token);

    expect(identity).toBeNull();
  });

  it("returns null when the token's issuer isn't Google", async () => {
    const token = await signIdToken({ issuer: "https://evil.example.com" });

    const identity = await verifyGoogleIdToken(token);

    expect(identity).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const token = await signIdToken({ ttlSeconds: -1 });

    const identity = await verifyGoogleIdToken(token);

    expect(identity).toBeNull();
  });

  it("returns null for a malformed token string rather than throwing", async () => {
    const identity = await verifyGoogleIdToken("not-a-jwt");

    expect(identity).toBeNull();
  });

  it("fails closed (returns null) when GOOGLE_OAUTH_CLIENT_ID isn't configured, even for an otherwise-valid token", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    vi.resetModules();
    const { verifyGoogleIdToken: freshVerify } = await import("./oauth.js");

    const token = await signIdToken();

    const identity = await freshVerify(token);

    expect(identity).toBeNull();
  });
});

describe("exchangeGoogleCode", () => {
  let exchangeGoogleCode: typeof ExchangeGoogleCode;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
    };
    vi.resetModules();
    ({ exchangeGoogleCode } = await import("./oauth.js"));
  });

  it("returns the id token for a 200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id_token: "google-id-token", token_type: "Bearer" })),
    );

    const idToken = await exchangeGoogleCode(
      "a-code",
      "a-verifier",
      "https://kvy-cli.tkvy.dev/auth/callback/google/",
    );

    expect(idToken).toBe("google-id-token");
  });

  it("sends client_id, client_secret, code, and code_verifier to Google's token endpoint", async () => {
    let sentBody: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === GOOGLE_TOKEN_URL) {
          sentBody = new URLSearchParams(init?.body as string);
          return jsonResponse({ id_token: "google-id-token" });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );

    await exchangeGoogleCode(
      "a-code",
      "a-verifier",
      "https://kvy-cli.tkvy.dev/auth/callback/google/",
    );

    expect(sentBody?.get("client_id")).toBe("test-google-client-id");
    expect(sentBody?.get("client_secret")).toBe("test-google-client-secret");
    expect(sentBody?.get("code")).toBe("a-code");
    expect(sentBody?.get("code_verifier")).toBe("a-verifier");
    expect(sentBody?.get("redirect_uri")).toBe("https://kvy-cli.tkvy.dev/auth/callback/google/");
  });

  it("returns null for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
    );

    const idToken = await exchangeGoogleCode(
      "bad-code",
      "a-verifier",
      "https://kvy-cli.tkvy.dev/auth/callback/google/",
    );

    expect(idToken).toBeNull();
  });

  it("returns null when the response has no id_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "unrelated" })),
    );

    const idToken = await exchangeGoogleCode(
      "a-code",
      "a-verifier",
      "https://kvy-cli.tkvy.dev/auth/callback/google/",
    );

    expect(idToken).toBeNull();
  });

  it("returns null (not a throw) when the fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const idToken = await exchangeGoogleCode(
      "a-code",
      "a-verifier",
      "https://kvy-cli.tkvy.dev/auth/callback/google/",
    );

    expect(idToken).toBeNull();
  });

  it("fails closed (returns null) when Google OAuth credentials aren't configured", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    vi.resetModules();
    const { exchangeGoogleCode: freshExchange } = await import("./oauth.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id_token: "google-id-token" })),
    );

    const idToken = await freshExchange(
      "a-code",
      "a-verifier",
      "https://kvy-cli.tkvy.dev/auth/callback/google/",
    );

    expect(idToken).toBeNull();
  });
});

describe("verifyGithubAccessToken", () => {
  let verifyGithubAccessToken: typeof VerifyGithubAccessToken;

  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, GITHUB_OAUTH_CLIENT_ID: "test-github-client-id" };
    vi.resetModules();
    ({ verifyGithubAccessToken } = await import("./oauth.js"));
  });

  function stubGithubUser(profile: unknown, emails: unknown = []) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === GITHUB_USER_URL) return jsonResponse(profile);
        if (url === GITHUB_EMAILS_URL) return jsonResponse(emails);
        throw new Error(`unexpected fetch in verifyGithubAccessToken test: ${url}`);
      }),
    );
  }

  it("returns the identity for a 200 response with a numeric id", async () => {
    stubGithubUser({
      id: 42,
      login: "octocat",
      name: "octocat",
      avatar_url: "https://avatars.example.com/octocat.png",
    });

    const identity = await verifyGithubAccessToken("gho_validtoken");

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: null,
      emailVerified: false,
      image: "https://avatars.example.com/octocat.png",
    });
  });

  it("returns null for a non-2xx response (invalid/expired token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401)),
    );

    const identity = await verifyGithubAccessToken("gho_badtoken");

    expect(identity).toBeNull();
  });

  it("returns null when the response body has no id", async () => {
    stubGithubUser({ login: "octocat", name: "octocat", avatar_url: "" });

    const identity = await verifyGithubAccessToken("gho_validtoken");

    expect(identity).toBeNull();
  });

  it("returns null (not a throw) when the fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const identity = await verifyGithubAccessToken("gho_validtoken");

    expect(identity).toBeNull();
  });

  it("uses the primary verified address from /user/emails when /user's own email is private (null)", async () => {
    stubGithubUser({ id: 42, login: "octocat", email: null, name: "octocat", avatar_url: "" }, [
      { email: "secondary@example.com", primary: false, verified: true },
      { email: "primary@example.com", primary: true, verified: true },
    ]);

    const identity = await verifyGithubAccessToken("gho_validtoken");

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: "primary@example.com",
      emailVerified: true,
      image: "",
    });
  });

  it("stores an unverified primary email but flags it — never treats it as authoritative", async () => {
    stubGithubUser({ id: 42, login: "octocat", email: null, name: "octocat", avatar_url: "" }, [
      { email: "unverified@example.com", primary: true, verified: false },
    ]);

    const identity = await verifyGithubAccessToken("gho_validtoken");

    expect(identity?.email).toBe("unverified@example.com");
    expect(identity?.emailVerified).toBe(false);
  });

  it("degrades to email:null when /user/emails is unreachable rather than failing the whole sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === GITHUB_USER_URL) {
          return jsonResponse({
            id: 42,
            login: "octocat",
            email: null,
            name: "octocat",
            avatar_url: "",
          });
        }
        if (url === GITHUB_EMAILS_URL) return jsonResponse({ message: "Forbidden" }, 403);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const identity = await verifyGithubAccessToken("gho_validtoken");

    expect(identity).toEqual({
      provider: "github",
      subject: "42",
      email: null,
      emailVerified: false,
      image: "",
    });
  });
});

describe("exchangeGithubCode", () => {
  let exchangeGithubCode: typeof ExchangeGithubCode;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      GITHUB_OAUTH_CLIENT_ID: "test-github-client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "test-github-client-secret",
    };
    vi.resetModules();
    ({ exchangeGithubCode } = await import("./oauth.js"));
  });

  it("returns the access token for a 200 response with a token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "gho_realtoken" })),
    );

    const token = await exchangeGithubCode("a-code", "https://app.kvy.dev/auth/callback/github");

    expect(token).toBe("gho_realtoken");
  });

  it("sends client_id, client_secret, code, and redirect_uri to GitHub's token endpoint", async () => {
    let sentBody: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === GITHUB_TOKEN_URL) {
          sentBody = new URLSearchParams(init?.body as string);
          return jsonResponse({ access_token: "gho_realtoken" });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );

    await exchangeGithubCode("a-code", "https://app.kvy.dev/auth/callback/github");

    expect(sentBody?.get("client_id")).toBe("test-github-client-id");
    expect(sentBody?.get("client_secret")).toBe("test-github-client-secret");
    expect(sentBody?.get("code")).toBe("a-code");
    expect(sentBody?.get("redirect_uri")).toBe("https://app.kvy.dev/auth/callback/github");
  });

  it("returns null for a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "bad_verification_code" }, 401)),
    );

    const token = await exchangeGithubCode("bad-code", "https://app.kvy.dev/auth/callback/github");

    expect(token).toBeNull();
  });

  it("returns null when the response body has no access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "incorrect_client_credentials" })),
    );

    const token = await exchangeGithubCode("a-code", "https://app.kvy.dev/auth/callback/github");

    expect(token).toBeNull();
  });

  it("returns null (not a throw) when the fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const token = await exchangeGithubCode("a-code", "https://app.kvy.dev/auth/callback/github");

    expect(token).toBeNull();
  });

  it("fails closed (returns null) when GitHub OAuth credentials aren't configured", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    vi.resetModules();
    const { exchangeGithubCode: freshExchange } = await import("./oauth.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ access_token: "gho_realtoken" })),
    );

    const token = await freshExchange("a-code", "https://app.kvy.dev/auth/callback/github");

    expect(token).toBeNull();
  });
});
