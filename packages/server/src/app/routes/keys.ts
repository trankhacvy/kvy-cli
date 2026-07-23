/**
 * `POST /v1/auth/keys/challenge` + `POST /v1/auth/keys/bind` — issue-4-plan.md §6.2: binds
 * (or fenced-rotates) an account's key-custody material (`signPublicKey`/`contentPubKey`/
 * `keyEpoch`), now that identity (login) and key custody are separate. Both routes require
 * `app.authenticate` — key binding always happens as an already-logged-in account, never
 * as part of login itself.
 */
import { randomBytes } from "node:crypto";
import { decodeBase64 } from "@falcon/crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";
import { z } from "zod";
import { accounts, deviceSessions, keyBindNonces } from "../../db/schema.js";
import type { Database } from "../../db/types.js";
import { toHex } from "./hex.js";

const CHALLENGE_TTL_MS = 120_000;

const ErrorSchema = z.object({ error: z.string() });

async function consumeNonce(db: Database, accountId: string, nonce: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(keyBindNonces)
    .set({ consumedAt: now })
    .where(
      and(
        eq(keyBindNonces.nonce, nonce),
        eq(keyBindNonces.accountId, accountId),
        isNull(keyBindNonces.consumedAt),
        gt(keyBindNonces.expiresAt, now),
      ),
    )
    .returning({ id: keyBindNonces.id });
  return rows.length > 0;
}

/**
 * "Other devices are online" interlock (§6.2): a rotation while another session is
 * still healthy would race that session's next write under the old key — make the
 * user pair from one of those devices instead of rotating blind.
 */
async function hasOtherHealthySessions(
  db: Database,
  accountId: string,
  currentSessionId: string,
): Promise<boolean> {
  const now = new Date();
  const row = await db.query.deviceSessions.findFirst({
    where: and(
      eq(deviceSessions.accountId, accountId),
      ne(deviceSessions.id, currentSessionId),
      isNull(deviceSessions.revokedAt),
      gt(deviceSessions.expiresAt, now),
    ),
  });
  return Boolean(row);
}

/**
 * Step-up verification for a destructive rotation. issue-4-plan.md's illustrative
 * snippet leaves this as a `stepUpProof` opaque string; a real implementation needs a
 * concrete proof shape (re-entered password, or a fresh OAuth proof) wired to
 * `auth/password.ts`/`auth/oauth.ts` — deferred here (see docs/issue-4-plan.md's Phase 2
 * checklist note). Until that lands, this always returns `false`, so a rotation attempt
 * fails closed (401) rather than silently skipping the check.
 */
async function verifyStepUp(_db: Database, _accountId: string, _proof: string | undefined): Promise<boolean> {
  return false;
}

export function buildKeysRoutes(db: Database): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/auth/keys/challenge",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: { response: { 200: z.object({ nonce: z.string() }) } },
      },
      async (request, reply) => {
        const nonce = randomBytes(32).toString("base64");
        await db.insert(keyBindNonces).values({
          accountId: request.accountId,
          nonce,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        });
        return reply.send({ nonce });
      },
    );

    app.post(
      "/v1/auth/keys/bind",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
          body: z.object({
            signPubKey: z.string().min(1),
            contentPubKey: z.string().min(1),
            nonce: z.string().min(1),
            signature: z.string().min(1),
            rotate: z.boolean().optional(),
            stepUpProof: z.string().optional(),
          }),
          response: {
            200: z.object({ success: z.literal(true), keyEpoch: z.number() }),
            401: ErrorSchema,
            409: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const nonceOk = await consumeNonce(db, request.accountId, request.body.nonce);
        if (!nonceOk) return reply.code(401).send({ error: "Invalid or expired nonce" });

        const publicKey = decodeBase64(request.body.signPubKey);
        if (publicKey.length !== tweetnacl.sign.publicKeyLength) {
          return reply.code(401).send({ error: "Invalid signature" });
        }

        // Signature covers accountId‖contentPubKey‖nonce — a server-issued nonce, not a
        // bare client-chosen value, so it can't be replayed across accounts or sessions.
        const signed = new Uint8Array([
          ...new TextEncoder().encode(request.accountId),
          ...decodeBase64(request.body.contentPubKey),
          ...decodeBase64(request.body.nonce),
        ]);
        let signatureValid: boolean;
        try {
          signatureValid = tweetnacl.sign.detached.verify(
            signed,
            decodeBase64(request.body.signature),
            publicKey,
          );
        } catch {
          signatureValid = false;
        }
        if (!signatureValid) return reply.code(401).send({ error: "Invalid signature" });

        const account = await db.query.accounts.findFirst({
          where: eq(accounts.id, request.accountId),
        });
        if (!account) return reply.code(401).send({ error: "Account not found" });

        const signPublicKeyHex = toHex(publicKey);
        const isFirstBind = account.keyEpoch === 0;
        const sameKey = account.signPublicKey === signPublicKeyHex;

        if (!isFirstBind && !sameKey) {
          if (!request.body.rotate) {
            return reply.code(409).send({ error: "Key mismatch; rotation must be explicit" });
          }
          if (!(await verifyStepUp(db, request.accountId, request.body.stepUpProof))) {
            return reply.code(401).send({ error: "Step-up required to rotate keys" });
          }
          if (await hasOtherHealthySessions(db, request.accountId, request.sessionId)) {
            return reply
              .code(409)
              .send({ error: "Other devices are online — pair from one instead of rotating" });
          }
        }

        const conflict = await db.query.accounts.findFirst({
          where: and(eq(accounts.signPublicKey, signPublicKeyHex), ne(accounts.id, request.accountId)),
        });
        if (conflict) return reply.code(409).send({ error: "Key already bound to another account" });

        const newEpoch = isFirstBind ? 1 : sameKey ? account.keyEpoch : account.keyEpoch + 1;

        await db.transaction(async (tx) => {
          await tx
            .update(accounts)
            .set({
              signPublicKey: signPublicKeyHex,
              contentPubKey: request.body.contentPubKey,
              keyEpoch: newEpoch,
            })
            .where(eq(accounts.id, request.accountId));

          if (!isFirstBind && !sameKey) {
            // Fence the split-brain (§6.2): kill every OTHER session so a stale daemon
            // still holding the old masterSecret can't keep writing under the dead epoch.
            await tx
              .update(deviceSessions)
              .set({ revokedAt: new Date() })
              .where(
                and(eq(deviceSessions.accountId, request.accountId), ne(deviceSessions.id, request.sessionId)),
              );
          }
        });

        return reply.send({ success: true, keyEpoch: newEpoch });
      },
    );
  };
}
