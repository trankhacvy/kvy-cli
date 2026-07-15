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
import { verifyToken } from "../../auth/index.js";
import { accounts } from "../../db/schema.js";
import { buildServer } from "../server.js";

// In-memory Postgres (WASM, `@electric-sql/pglite`) migrated with the same SQL that
// `drizzle-kit generate` produced for production (packages/server/drizzle/) — this is
// a real integration test against a real Postgres dialect, just without a Docker/
// network dependency, so it runs the same in CI as it does locally.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function signedChallenge() {
  const keypair = tweetnacl.sign.keyPair();
  const challenge = getRandomBytes(32);
  const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);
  return {
    signPublicKeyHex: toHex(keypair.publicKey),
    body: {
      publicKey: encodeBase64(keypair.publicKey),
      contentPublicKey: encodeBase64(getRandomBytes(32)),
      challenge: encodeBase64(challenge),
      signature: encodeBase64(signature),
    },
  };
}

describe("POST /v1/auth", () => {
  let pglite: PGlite;
  let app: FastifyInstance;

  beforeAll(async () => {
    pglite = new PGlite();
    const db = drizzle(pglite, { schema: { accounts } });
    await migrate(db, { migrationsFolder });

    app = await buildServer({ logger: false }, { db });
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  it("rejects a signature that doesn't match the challenge", async () => {
    const { body } = signedChallenge();
    body.challenge = encodeBase64(getRandomBytes(32)); // swap challenge after signing

    const response = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid signature" });
  });

  it("returns 401 (not 500) for a malformed/wrong-length public key rather than throwing", async () => {
    const { body } = signedChallenge();
    // 4 bytes, not a valid Ed25519 public key length — tweetnacl.verify throws on this,
    // which the route's try/catch must collapse to a 401, not an unhandled 500.
    body.publicKey = encodeBase64(new Uint8Array([1, 2, 3, 4]));

    const response = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid signature" });
  });

  it("mints a valid JWT for a fresh signPublicKey", async () => {
    const { body } = signedChallenge();
    const response = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    expect(responseBody.success).toBe(true);

    const verified = await verifyToken(responseBody.token);
    expect(verified?.accountId).toEqual(expect.any(String));
  });

  it("same signPublicKey posted twice yields one account row (idempotent upsert) and a valid JWT both times", async () => {
    const { signPublicKeyHex, body } = signedChallenge();

    const first = await app.inject({ method: "POST", url: "/v1/auth", payload: body });
    const second = await app.inject({ method: "POST", url: "/v1/auth", payload: body });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstVerified = await verifyToken(first.json().token);
    const secondVerified = await verifyToken(second.json().token);
    expect(firstVerified?.accountId).toBeTruthy();
    expect(firstVerified?.accountId).toBe(secondVerified?.accountId);

    const db = drizzle(pglite, { schema: { accounts } });
    const rows = await db.select().from(accounts).where(eq(accounts.signPublicKey, signPublicKeyHex));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(firstVerified?.accountId);
  });
});
