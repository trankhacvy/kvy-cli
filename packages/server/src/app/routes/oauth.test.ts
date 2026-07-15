import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@falcon/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import tweetnacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OAuthIdentity, OAuthProvider, OAuthVerifier } from "../../auth/oauth.js";
import { verifyToken } from "../../auth/tokens.js";
import { accounts } from "../../db/schema.js";
import { buildServer } from "../server.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

// Fake verifier: proofs are just `"<provider>:<subject>"` strings, or the literal
// string `"invalid"` to simulate a rejected proof — keeps these tests off the network
// entirely (mirrors the `db` injection pattern in auth.test.ts).
function fakeVerifier(): OAuthVerifier {
  return {
    async verify(provider: OAuthProvider, proof: string): Promise<OAuthIdentity | null> {
      if (proof === "invalid") return null;
      const [proofProvider, subject] = proof.split(":");
      if (proofProvider !== provider || !subject) return null;
      return { provider, subject };
    },
  };
}

function registerBody(
  overrides: Partial<{ oauthProvider: OAuthProvider; oauthProof: string }> = {},
) {
  const keypair = tweetnacl.sign.keyPair();
  return {
    body: {
      oauthProvider: overrides.oauthProvider ?? "google",
      oauthProof: overrides.oauthProof ?? "google:google-subject-1",
      signPubKey: encodeBase64(keypair.publicKey),
      contentPubKey: encodeBase64(getRandomBytes(32)),
    },
  };
}

describe("POST /v1/auth/register", () => {
  let pglite: PGlite;
  let app: FastifyInstance;

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite, { schema: { accounts } });
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

    const db = drizzle(pglite, { schema: { accounts } });
    const [row] = await db.select().from(accounts).where(eq(accounts.id, verified!.accountId));
    expect(row?.oauthProvider).toBe("google");
    expect(row?.oauthSubject).toBe("alice-sub");
  });

  it("returns 401 (not 500) when the OAuth proof fails verification", async () => {
    const { body } = registerBody({ oauthProof: "invalid" });

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid OAuth proof" });
  });

  it("returns 400 for a malformed/wrong-length signPubKey", async () => {
    const { body } = registerBody();
    body.signPubKey = encodeBase64(new Uint8Array([1, 2, 3, 4]));

    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: body });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Malformed signPubKey" });
  });

  it("rebinds oauthProvider/oauthSubject on the same signPubKey rather than creating a second row", async () => {
    const keypair = tweetnacl.sign.keyPair();
    const signPubKey = encodeBase64(keypair.publicKey);

    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        oauthProvider: "google",
        oauthProof: "google:bob-google-sub",
        signPubKey,
        contentPubKey: encodeBase64(getRandomBytes(32)),
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        oauthProvider: "github",
        oauthProof: "github:bob-github-sub",
        signPubKey,
        contentPubKey: encodeBase64(getRandomBytes(32)),
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstVerified = await verifyToken(first.json().token);
    const secondVerified = await verifyToken(second.json().token);
    expect(firstVerified?.accountId).toBe(secondVerified?.accountId);

    const db = drizzle(pglite, { schema: { accounts } });
    const rows = await db.select().from(accounts).where(eq(accounts.id, firstVerified!.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.oauthProvider).toBe("github");
    expect(rows[0]?.oauthSubject).toBe("bob-github-sub");
  });

  it("the same account row is usable by /v1/auth's challenge/response afterward", async () => {
    const keypair = tweetnacl.sign.keyPair();
    const registerResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        oauthProvider: "google",
        oauthProof: "google:carol-sub",
        signPubKey: encodeBase64(keypair.publicKey),
        contentPubKey: encodeBase64(getRandomBytes(32)),
      },
    });
    expect(registerResponse.statusCode).toBe(200);
    const registeredAccountId = (await verifyToken(registerResponse.json().token))?.accountId;

    const challenge = getRandomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);
    const loginResponse = await app.inject({
      method: "POST",
      url: "/v1/auth",
      payload: {
        publicKey: encodeBase64(keypair.publicKey),
        contentPublicKey: encodeBase64(getRandomBytes(32)),
        challenge: encodeBase64(challenge),
        signature: encodeBase64(signature),
      },
    });

    expect(loginResponse.statusCode).toBe(200);
    const loginAccountId = (await verifyToken(loginResponse.json().token))?.accountId;
    expect(loginAccountId).toBe(registeredAccountId);
  });
});
