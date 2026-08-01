import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  GithubCodeExchanger,
  OAuthIdentity,
  OAuthProvider,
  OAuthVerifier,
} from "../../auth/oauth.js";
import { verifyToken } from "../../auth/tokens.js";
import * as schema from "../../db/schema.js";
import { authIdentities } from "../../db/schema.js";
import { buildServer } from "../server.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

// Fake verifier: proofs are `"<provider>:<subject>"`, optionally extended with
// `:<email>:verified` or `:<email>:unverified` to exercise email capture, or the
// literal string `"invalid"` to simulate a rejected proof — keeps these tests off
// the network entirely (mirrors the `db` injection pattern in auth.test.ts).
function fakeVerifier(): OAuthVerifier {
  return {
    async verify(provider: OAuthProvider, proof: string): Promise<OAuthIdentity | null> {
      if (proof === "invalid") return null;
      const [proofProvider, subject, email, verifiedFlag] = proof.split(":");
      if (proofProvider !== provider || !subject) return null;
      return {
        provider,
        subject,
        email: email ?? null,
        emailVerified: verifiedFlag === "verified",
      };
    },
  };
}

function registerBody(
  overrides: Partial<{ oauthProvider: OAuthProvider; oauthProof: string }> = {},
) {
  return {
    body: {
      oauthProvider: overrides.oauthProvider ?? "google",
      oauthProof: overrides.oauthProof ?? "google:google-subject-1",
    },
  };
}

describe("POST /v1/auth/register", () => {
  let pglite: PGlite;
  let app: FastifyInstance;

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });

    app = await buildServer({ logger: false }, { db, oauthVerifier: fakeVerifier() });
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("creates an account bound to the OAuth identity and returns a valid JWT", async () => {
    const { body } = registerBody({ oauthProvider: "google", oauthProof: "google:alice-sub" });

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    expect(responseBody.success).toBe(true);

    const verified = await verifyToken(responseBody.token);
    expect(verified?.accountId).toEqual(expect.any(String));

    const db = drizzle(pglite, { schema });
    const [row] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, verified?.accountId ?? ""));
    expect(row?.kind).toBe("google");
    expect(row?.identifier).toBe("alice-sub");
  });

  it("returns 401 (not 500) when the OAuth proof fails verification", async () => {
    const { body } = registerBody({ oauthProof: "invalid" });

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid OAuth proof" });
  });

  it("signing in twice with the same OAuth identity resolves to one account, not two", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { oauthProvider: "google", oauthProof: "google:bob-google-sub" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { oauthProvider: "google", oauthProof: "google:bob-google-sub" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstVerified = await verifyToken(first.json().token);
    const secondVerified = await verifyToken(second.json().token);
    expect(firstVerified?.accountId).toBeTruthy();
    expect(firstVerified?.accountId).toBe(secondVerified?.accountId);

    const db = drizzle(pglite, { schema });
    const rows = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, firstVerified?.accountId ?? ""));
    expect(rows).toHaveLength(1);
  });

  it("different OAuth providers for the same person create distinct accounts (no cross-provider linking)", async () => {
    const google = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { oauthProvider: "google", oauthProof: "google:carol-sub" },
    });
    const github = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { oauthProvider: "github", oauthProof: "github:carol-sub" },
    });

    const googleVerified = await verifyToken(google.json().token);
    const githubVerified = await verifyToken(github.json().token);
    expect(googleVerified?.accountId).not.toBe(githubVerified?.accountId);
  });

  it("persists the identity's email and emailVerified onto the auth_identities insert", async () => {
    const { body } = registerBody({
      oauthProvider: "google",
      oauthProof: "google:dave-sub:dave@example.com:verified",
    });

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });
    expect(response.statusCode).toBe(200);
    const verified = await verifyToken(response.json().token);

    const db = drizzle(pglite, { schema });
    const [row] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, verified?.accountId ?? ""));
    expect(row?.email).toBe("dave@example.com");
    expect(row?.emailVerified).toBe(true);
  });

  it("stores an unverified email but flags it — never treated as authoritative", async () => {
    const { body } = registerBody({
      oauthProvider: "google",
      oauthProof: "google:frank-sub:frank@example.com:unverified",
    });

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });
    const verified = await verifyToken(response.json().token);

    const db = drizzle(pglite, { schema });
    const [row] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, verified?.accountId ?? ""));
    expect(row?.email).toBe("frank@example.com");
    expect(row?.emailVerified).toBe(false);
  });

  it("backfills email on a returning identity that had none, without touching an already-set one", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { oauthProvider: "google", oauthProof: "google:erin-sub" },
    });
    const firstVerified = await verifyToken(first.json().token);

    const db = drizzle(pglite, { schema });
    const [beforeBackfill] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, firstVerified?.accountId ?? ""));
    expect(beforeBackfill?.email).toBeNull();

    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        oauthProvider: "google",
        oauthProof: "google:erin-sub:erin@example.com:verified",
      },
    });
    const secondVerified = await verifyToken(second.json().token);
    expect(secondVerified?.accountId).toBe(firstVerified?.accountId);

    const [afterBackfill] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, firstVerified?.accountId ?? ""));
    expect(afterBackfill?.email).toBe("erin@example.com");
    expect(afterBackfill?.emailVerified).toBe(true);

    // A third login reporting a *different* email never overwrites the one on file —
    // the backfill only fills an empty column (issue-6 §6g).
    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        oauthProvider: "google",
        oauthProof: "google:erin-sub:changed@example.com:verified",
      },
    });
    const [afterThirdLogin] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.accountId, firstVerified?.accountId ?? ""));
    expect(afterThirdLogin?.email).toBe("erin@example.com");
  });
});

// Fake exchanger: `"valid-code"` succeeds, anything else fails — keeps these tests off
// the network entirely (mirrors `fakeVerifier` above).
function fakeGithubExchanger(): GithubCodeExchanger {
  return {
    async exchange(code: string) {
      return code === "valid-code" ? "gho_faketoken" : null;
    },
  };
}

describe("POST /v1/auth/oauth/github/exchange", () => {
  let pglite: PGlite;
  let app: FastifyInstance;

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });

    app = await buildServer(
      { logger: false },
      { db, oauthVerifier: fakeVerifier(), githubExchanger: fakeGithubExchanger() },
    );
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("returns the access token for a valid code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/oauth/github/exchange",
      payload: { code: "valid-code", redirectUri: "https://app.kvy.dev/auth/callback/github" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accessToken: "gho_faketoken" });
  });

  it("returns 401 when the exchanger rejects the code", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/oauth/github/exchange",
      payload: { code: "bad-code", redirectUri: "https://app.kvy.dev/auth/callback/github" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "GitHub code exchange failed" });
  });

  it("returns 400 when the body is missing redirectUri", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/oauth/github/exchange",
      payload: { code: "valid-code" },
    });

    expect(response.statusCode).toBe(400);
  });
});
