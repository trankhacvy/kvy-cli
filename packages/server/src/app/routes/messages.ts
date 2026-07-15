import { type EncryptedBox, EncryptedBoxSchema } from "@falcon/wire";
import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { decodeBox, encodeBox } from "../../db/box.js";
import { isUniqueViolation } from "../../db/errors.js";
import { sessionMessages, sessions } from "../../db/schema.js";
import { allocMsgSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

// One flush from the CLI's coalescing outbox is one POST (plan.md §6.5:
// "flush every 300ms or 20 events"). The outbox's own disk-backed queue caps
// at 10MB; give a single batch's EncryptedBox (base64, ~33% larger than raw)
// headroom above that before Fastify's body-size guard kicks in.
const MESSAGE_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const PostMessageBodySchema = z.object({
  localId: z.string().min(1),
  content: EncryptedBoxSchema,
});
const PostMessageResponseSchema = z.object({ seq: z.number() });

const ListMessagesQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
const MessageItemSchema = z.object({
  seq: z.number(),
  localId: z.string().nullable(),
  content: EncryptedBoxSchema,
  createdAt: z.number(),
});
const ListMessagesResponseSchema = z.object({
  messages: z.array(MessageItemSchema),
  nextBefore: z.number().nullable(),
});

type InsertOutcome = { seq: number; fanOut: boolean } | null;

/**
 * `POST /v1/sessions/:id/messages` + `GET /v1/sessions/:id/messages`
 * (design §4.3 — ⚠ DELTA D1, the biggest change from Happy: this logic lived
 * in `sessionUpdateHandler.ts`'s WS `message` handler there; here it's an
 * idempotent HTTP route so a retry has unambiguous delivery semantics).
 */
export function buildMessagesRoutes(db: Database, eventRouter: EventRouterPort): FastifyPluginAsyncZod {
  /**
   * Looks up `(sessionId, localId)` first (the fast, uncontended path); on a
   * genuine miss, allocates a `msgSeq` and inserts. If two requests for the
   * *same* `localId` race past that lookup simultaneously, the unique index
   * on `(session_id, local_id)` rejects the loser's insert — caught below and
   * turned into the same replay a sequential retry would get, so a blind
   * client retry is safe under concurrency too, not just in sequence.
   */
  async function insertMessage(
    sessionId: string,
    accountId: string,
    localId: string,
    content: EncryptedBox,
  ): Promise<InsertOutcome> {
    try {
      return await db.transaction(async (tx) => {
        const session = await tx.query.sessions.findFirst({
          where: and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)),
        });
        if (!session) return null;

        const existing = await tx.query.sessionMessages.findFirst({
          where: and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.localId, localId)),
        });
        if (existing) return { seq: existing.seq, fanOut: false };

        const seq = await allocMsgSeq(tx, sessionId);
        await tx.insert(sessionMessages).values({
          sessionId,
          seq,
          localId,
          content: encodeBox(content),
        });
        return { seq, fanOut: true };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.query.sessionMessages.findFirst({
        where: and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.localId, localId)),
      });
      if (!existing) throw err; // genuinely unexpected — rethrow rather than swallow
      return { seq: existing.seq, fanOut: false };
    }
  }

  return async (app) => {
    app.post(
      "/v1/sessions/:id/messages",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
        bodyLimit: MESSAGE_BODY_LIMIT_BYTES,
        schema: {
          params: SessionIdParamsSchema,
          body: PostMessageBodySchema,
          response: { 200: PostMessageResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const { localId, content } = req.body;
        const accountId = req.accountId;

        const result = await insertMessage(id, accountId, localId, content);
        if (!result) return reply.code(404).send({});

        // Post-commit fan-out — NEVER inside the tx (design §6.1). Only the
        // request that actually inserted the row fans out; a localId replay
        // returns the same `seq` without emitting a second event.
        if (result.fanOut) {
          reply.raw.once("finish", () => {
            eventRouter.emitUpdate({
              accountId,
              recipientFilter: { type: "all-interested-in-session", sessionId: id },
              payload: {
                ts: Date.now(),
                body: { t: "message-new", sessionId: id, msgSeq: result.seq, localId, content },
              },
            });
          });
        }
        return { seq: result.seq };
      },
    );

    app.get(
      "/v1/sessions/:id/messages",
      {
        preHandler: app.authenticate,
        schema: {
          params: SessionIdParamsSchema,
          querystring: ListMessagesQuerySchema,
          response: { 200: ListMessagesResponseSchema, 404: NotFoundSchema },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const { before, limit } = req.query;
        const accountId = req.accountId;

        const session = await db.query.sessions.findFirst({
          where: and(eq(sessions.id, id), eq(sessions.accountId, accountId)),
        });
        if (!session) return reply.code(404).send({});

        const rows = await db.query.sessionMessages.findMany({
          where:
            before !== undefined
              ? and(eq(sessionMessages.sessionId, id), lt(sessionMessages.seq, before))
              : eq(sessionMessages.sessionId, id),
          orderBy: [desc(sessionMessages.seq)],
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const oldest = page[page.length - 1];

        return {
          messages: page.map((m) => ({
            seq: m.seq,
            localId: m.localId,
            content: decodeBox(m.content),
            createdAt: m.createdAt.getTime(),
          })),
          nextBefore: hasMore && oldest ? oldest.seq : null,
        };
      },
    );
  };
}
