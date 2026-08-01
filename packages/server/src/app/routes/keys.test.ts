import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { encodeBase64, getRandomBytes } from "@kvy/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import tweetnacl from "tweetnacl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../auth/password.js";
import { issueSession } from "../../auth/refresh.js";
import * as schema from "../../db/schema.js";
import { accounts, authIdentities, deviceSessions } from "../../db/schema.js";
import { buildServer } from "../server.js";
import { createTestAccount } from "./testHelpers.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

function signBindPayload(
  accountId: string,
  contentPubKey: string,
  nonce: string,
  secretKey: Uint8Array,
) {
  const signed = new Uint8Array([
    ...new TextEncoder().encode(accountId),
    ...Buffer.from(contentPubKey, "base64"),
    ...Buffer.from(nonce, "base64"),
  ]);
  return encodeBase64(tweetnacl.sign.detached(signed, secretKey));
}

describe("keys/challenge + keys/bind", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let app: FastifyInstance;

  beforeAll(async () => {
    pglite = new PGlite();
    db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder });
    app = await buildServer({ logger: false }, { db });
  });

  afterAll(async () => {
    await app.close();
    await pglite.close();
  });

  async function challenge(authHeader: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/challenge",
      headers: { authorization: authHeader },
    });
    return response.json().nonce;
  }

  it("first bind: sets signPubKey/contentPubKey and moves keyEpoch 0 -> 1", async () => {
    const { account, authHeader } = await createTestAccount(db);
    const nonce = await challenge(authHeader);
    const keypair = tweetnacl.sign.keyPair();
    const contentPubKey = encodeBase64(getRandomBytes(32));
    const signature = signBindPayload(account.id, contentPubKey, nonce, keypair.secretKey);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: authHeader },
      payload: {
        signPubKey: encodeBase64(keypair.publicKey),
        contentPubKey,
        nonce,
        signature,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, keyEpoch: 1 });

    const [row] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row?.keyEpoch).toBe(1);
    expect(row?.contentPubKey).toBe(contentPubKey);
  });

  it("rejects a reused (already-consumed) nonce", async () => {
    const { account, authHeader } = await createTestAccount(db);
    const nonce = await challenge(authHeader);
    const keypair = tweetnacl.sign.keyPair();
    const contentPubKey = encodeBase64(getRandomBytes(32));
    const signature = signBindPayload(account.id, contentPubKey, nonce, keypair.secretKey);
    const body = { signPubKey: encodeBase64(keypair.publicKey), contentPubKey, nonce, signature };

    const first = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: authHeader },
      payload: body,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: authHeader },
      payload: body,
    });
    expect(second.statusCode).toBe(401);
  });

  it("rejects an invalid signature", async () => {
    const { account, authHeader } = await createTestAccount(db);
    const nonce = await challenge(authHeader);
    const keypair = tweetnacl.sign.keyPair();
    const otherKeypair = tweetnacl.sign.keyPair();
    const contentPubKey = encodeBase64(getRandomBytes(32));
    // Signed with the WRONG secret key relative to the public key sent.
    const signature = signBindPayload(account.id, contentPubKey, nonce, otherKeypair.secretKey);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: authHeader },
      payload: { signPubKey: encodeBase64(keypair.publicKey), contentPubKey, nonce, signature },
    });

    expect(response.statusCode).toBe(401);
  });

  it("409s when the key already belongs to a different account", async () => {
    const first = await createTestAccount(db);
    const second = await createTestAccount(db);
    const sharedKeypair = tweetnacl.sign.keyPair();

    async function bindFor(actor: typeof first) {
      const nonce = await challenge(actor.authHeader);
      const contentPubKey = encodeBase64(getRandomBytes(32));
      const signature = signBindPayload(
        actor.account.id,
        contentPubKey,
        nonce,
        sharedKeypair.secretKey,
      );
      return app.inject({
        method: "POST",
        url: "/v1/auth/keys/bind",
        headers: { authorization: actor.authHeader },
        payload: {
          signPubKey: encodeBase64(sharedKeypair.publicKey),
          contentPubKey,
          nonce,
          signature,
        },
      });
    }

    const firstBind = await bindFor(first);
    expect(firstBind.statusCode).toBe(200);

    const secondBind = await bindFor(second);
    expect(secondBind.statusCode).toBe(409);
  });

  it("409s on an implicit rotation attempt (same account, different key, no rotate flag)", async () => {
    const actor = await createTestAccount(db);
    const firstKeypair = tweetnacl.sign.keyPair();

    const nonce1 = await challenge(actor.authHeader);
    const contentPubKey1 = encodeBase64(getRandomBytes(32));
    const sig1 = signBindPayload(actor.account.id, contentPubKey1, nonce1, firstKeypair.secretKey);
    const firstBind = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(firstKeypair.publicKey),
        contentPubKey: contentPubKey1,
        nonce: nonce1,
        signature: sig1,
      },
    });
    expect(firstBind.statusCode).toBe(200);

    const secondKeypair = tweetnacl.sign.keyPair();
    const nonce2 = await challenge(actor.authHeader);
    const contentPubKey2 = encodeBase64(getRandomBytes(32));
    const sig2 = signBindPayload(actor.account.id, contentPubKey2, nonce2, secondKeypair.secretKey);
    const secondBind = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(secondKeypair.publicKey),
        contentPubKey: contentPubKey2,
        nonce: nonce2,
        signature: sig2,
      },
    });

    expect(secondBind.statusCode).toBe(409);
    expect(secondBind.json()).toEqual({ error: "Key mismatch; rotation must be explicit" });
  });

  it("401s without an Authorization header", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/auth/keys/challenge" });
    expect(response.statusCode).toBe(401);
  });

  /** Same setup as `createTestAccount`, plus a real password `auth_identities` row so
   * `verifyStepUp`'s password branch has something to check against. */
  async function createTestPasswordAccount(password: string) {
    const [account] = await db.insert(accounts).values({}).returning();
    if (!account) throw new Error("insert returned no row");
    const passwordHash = await hashPassword(password);
    await db.insert(authIdentities).values({
      accountId: account.id,
      kind: "password",
      identifier: `${account.id}@example.com`,
      passwordHash,
      email: `${account.id}@example.com`,
    });
    const { accessToken, refreshToken } = await issueSession(db, {
      accountId: account.id,
      clientKind: "web",
    });
    return { account, refreshToken, authHeader: `Bearer ${accessToken}` };
  }

  it("rotation with a correct step-up password proof succeeds and bumps keyEpoch", async () => {
    const actor = await createTestPasswordAccount("correct horse battery staple");
    const firstKeypair = tweetnacl.sign.keyPair();
    const nonce1 = await challenge(actor.authHeader);
    const contentPubKey1 = encodeBase64(getRandomBytes(32));
    const sig1 = signBindPayload(actor.account.id, contentPubKey1, nonce1, firstKeypair.secretKey);
    const firstBind = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(firstKeypair.publicKey),
        contentPubKey: contentPubKey1,
        nonce: nonce1,
        signature: sig1,
      },
    });
    expect(firstBind.statusCode).toBe(200);

    const secondKeypair = tweetnacl.sign.keyPair();
    const nonce2 = await challenge(actor.authHeader);
    const contentPubKey2 = encodeBase64(getRandomBytes(32));
    const sig2 = signBindPayload(actor.account.id, contentPubKey2, nonce2, secondKeypair.secretKey);
    const rotateResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(secondKeypair.publicKey),
        contentPubKey: contentPubKey2,
        nonce: nonce2,
        signature: sig2,
        rotate: true,
        stepUpProof: { kind: "password", password: "correct horse battery staple" },
      },
    });

    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json()).toEqual({ success: true, keyEpoch: 2 });
  });

  it("rotation with a wrong step-up password fails closed (401), no rotation happens", async () => {
    const actor = await createTestPasswordAccount("correct horse battery staple");
    const firstKeypair = tweetnacl.sign.keyPair();
    const nonce1 = await challenge(actor.authHeader);
    const contentPubKey1 = encodeBase64(getRandomBytes(32));
    const sig1 = signBindPayload(actor.account.id, contentPubKey1, nonce1, firstKeypair.secretKey);
    await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(firstKeypair.publicKey),
        contentPubKey: contentPubKey1,
        nonce: nonce1,
        signature: sig1,
      },
    });

    const secondKeypair = tweetnacl.sign.keyPair();
    const nonce2 = await challenge(actor.authHeader);
    const contentPubKey2 = encodeBase64(getRandomBytes(32));
    const sig2 = signBindPayload(actor.account.id, contentPubKey2, nonce2, secondKeypair.secretKey);
    const rotateResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(secondKeypair.publicKey),
        contentPubKey: contentPubKey2,
        nonce: nonce2,
        signature: sig2,
        rotate: true,
        stepUpProof: { kind: "password", password: "wrong password" },
      },
    });

    expect(rotateResponse.statusCode).toBe(401);
    const [row] = await db.select().from(accounts).where(eq(accounts.id, actor.account.id));
    expect(row?.keyEpoch).toBe(1);
  });

  it("rotation is fenced with a 409 while another device session is still healthy — pair instead of rotating blind", async () => {
    const actor = await createTestPasswordAccount("correct horse battery staple");
    const firstKeypair = tweetnacl.sign.keyPair();
    const nonce1 = await challenge(actor.authHeader);
    const contentPubKey1 = encodeBase64(getRandomBytes(32));
    const sig1 = signBindPayload(actor.account.id, contentPubKey1, nonce1, firstKeypair.secretKey);
    await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(firstKeypair.publicKey),
        contentPubKey: contentPubKey1,
        nonce: nonce1,
        signature: sig1,
      },
    });

    // A second, still-healthy device session for the same account (e.g. another
    // signed-in browser tab) — this is exactly the situation the interlock exists for.
    await issueSession(db, { accountId: actor.account.id, clientKind: "web" });

    const secondKeypair = tweetnacl.sign.keyPair();
    const nonce2 = await challenge(actor.authHeader);
    const contentPubKey2 = encodeBase64(getRandomBytes(32));
    const sig2 = signBindPayload(actor.account.id, contentPubKey2, nonce2, secondKeypair.secretKey);
    const rotateResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(secondKeypair.publicKey),
        contentPubKey: contentPubKey2,
        nonce: nonce2,
        signature: sig2,
        rotate: true,
        stepUpProof: { kind: "password", password: "correct horse battery staple" },
      },
    });

    expect(rotateResponse.statusCode).toBe(409);
    expect(rotateResponse.json()).toEqual({
      error: "Other devices are online — pair from one instead of rotating",
    });
    const [row] = await db.select().from(accounts).where(eq(accounts.id, actor.account.id));
    expect(row?.keyEpoch).toBe(1);
  });

  it("a successful rotation revokes every OTHER session for the account, fencing the old epoch", async () => {
    const actor = await createTestPasswordAccount("correct horse battery staple");
    const firstKeypair = tweetnacl.sign.keyPair();
    const nonce1 = await challenge(actor.authHeader);
    const contentPubKey1 = encodeBase64(getRandomBytes(32));
    const sig1 = signBindPayload(actor.account.id, contentPubKey1, nonce1, firstKeypair.secretKey);
    await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(firstKeypair.publicKey),
        contentPubKey: contentPubKey1,
        nonce: nonce1,
        signature: sig1,
      },
    });

    const secondKeypair = tweetnacl.sign.keyPair();
    const nonce2 = await challenge(actor.authHeader);
    const contentPubKey2 = encodeBase64(getRandomBytes(32));
    const sig2 = signBindPayload(actor.account.id, contentPubKey2, nonce2, secondKeypair.secretKey);
    const rotateResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/keys/bind",
      headers: { authorization: actor.authHeader },
      payload: {
        signPubKey: encodeBase64(secondKeypair.publicKey),
        contentPubKey: contentPubKey2,
        nonce: nonce2,
        signature: sig2,
        rotate: true,
        stepUpProof: { kind: "password", password: "correct horse battery staple" },
      },
    });
    expect(rotateResponse.statusCode).toBe(200);

    // The very session that performed the rotation (`actor.authHeader`) must still be
    // alive — only OTHER sessions are fenced.
    const rows = await db
      .select()
      .from(deviceSessions)
      .where(eq(deviceSessions.accountId, actor.account.id));
    const revoked = rows.filter((r) => r.revokedAt !== null);
    const healthy = rows.filter((r) => r.revokedAt === null);
    expect(healthy.length).toBe(1);
    expect(revoked.length).toBe(rows.length - 1);
  });
});
