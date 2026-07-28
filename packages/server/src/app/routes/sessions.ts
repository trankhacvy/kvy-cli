import { decodeBase64 } from "@falcon/crypto";
import { EncryptedBoxSchema, SessionRowSchema } from "@falcon/wire";
import { and, count, desc, eq, inArray, lt, ne, or } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../../config.js";
import { encodeBox } from "../../db/box.js";
import { machines, sessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import type { PushDispatcherPort } from "../push/types.js";
import { reconcileStaleSessions } from "../staleSessions.js";
import { toSessionRow } from "./mappers.js";
import { decodeSessionCursor, encodeSessionCursor } from "./shared.js";

const CreateSessionBodySchema = z.object({
  tag: z.string().min(1),
  provider: z.enum(["claude-code", "codex"]),
  workspaceId: z.string().min(1).nullable().optional(),
  machineId: z.string().min(1).nullable().optional(),
  executionTarget: z.string().min(1).optional(),
  metadata: EncryptedBoxSchema,
  dek: z.string().min(1), // base64
});

const ListSessionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const ListSessionsResponseSchema = z.object({
  sessions: z.array(SessionRowSchema),
  nextCursor: z.string().nullable(),
});

/**
 * `POST /v1/sessions` + `GET /v1/sessions` (design §4.3/§6.2, plan.md §16
 * "1.2 Server write path").
 *
 * `db`/`eventRouter` are injected (not the module singletons) so tests can
 * bind an in-memory Postgres and assert on fan-out without a real socket —
 * same pattern as `buildAuthRoutes` (task 0.4).
 */
export function buildSessionsRoutes(
  db: Database,
  eventRouter: EventRouterPort,
  pushDispatcher: PushDispatcherPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/sessions",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: CreateSessionBodySchema,
          response: {
            200: SessionRowSchema,
            201: SessionRowSchema,
            429: z.object({ error: z.string() }),
          },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { tag, provider, workspaceId, machineId, executionTarget, metadata, dek } = req.body;

        // AX-7.1: concurrent-session quota. Checked before the insert, and deliberately
        // NOT inside the transaction — this route is idempotent by (accountId, tag), so a
        // retry of an already-created session must never be refused for being over quota.
        if (env.MAX_ACTIVE_SESSIONS_PER_ACCOUNT > 0) {
          const existingForTag = await db.query.sessions.findFirst({
            where: and(eq(sessions.accountId, accountId), eq(sessions.tag, tag)),
          });
          if (!existingForTag) {
            const [counted] = await db
              .select({ count: count() })
              .from(sessions)
              .where(and(eq(sessions.accountId, accountId), ne(sessions.status, "archived")));
            if ((counted?.count ?? 0) >= env.MAX_ACTIVE_SESSIONS_PER_ACCOUNT) {
              return reply.code(429).send({
                error: `You've reached your limit of ${env.MAX_ACTIVE_SESSIONS_PER_ACCOUNT} running sessions. Finish one before starting another.`,
              });
            }
          }
        }

        // Create-or-get by (accountId, tag) — idempotent (design §4.3). The
        // unique index on (account_id, tag) is the actual dedup mechanism
        // under concurrency; `onConflictDoNothing` + re-select turns a lost
        // race into the same 200-replay a sequential retry would get.
        const outcome = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(sessions)
            .values({
              accountId,
              tag,
              provider,
              workspaceId: workspaceId ?? null,
              machineId: machineId ?? null,
              ...(executionTarget ? { executionTarget } : {}),
              metadata: encodeBox(metadata),
              dek: decodeBase64(dek),
            })
            .onConflictDoNothing({ target: [sessions.accountId, sessions.tag] })
            .returning();

          if (inserted) {
            const headerSeq = await allocHeaderSeq(tx, accountId);
            return { row: inserted, created: true as const, headerSeq };
          }

          const existing = await tx.query.sessions.findFirst({
            where: and(eq(sessions.accountId, accountId), eq(sessions.tag, tag)),
          });
          if (!existing) {
            // Unreachable in practice: onConflictDoNothing only returns
            // nothing when the unique index already has a matching row.
            throw new Error(
              `POST /v1/sessions: conflict on (accountId, tag=${tag}) but no existing row found`,
            );
          }
          return { row: existing, created: false as const };
        });

        if (outcome.created) {
          reply.raw.once("finish", () => {
            eventRouter.emitUpdate({
              accountId,
              payload: {
                seq: outcome.headerSeq,
                ts: Date.now(),
                body: { t: "session-new", session: toSessionRow(outcome.row) },
              },
            });
          });
          reply.code(201);
        }
        return toSessionRow(outcome.row);
      },
    );

    app.get(
      "/v1/sessions",
      {
        preHandler: app.authenticate,
        schema: {
          querystring: ListSessionsQuerySchema,
          response: { 200: ListSessionsResponseSchema, 400: z.object({ error: z.string() }) },
        },
      },
      async (req, reply) => {
        const { cursor, limit } = req.query;
        const accountId = req.accountId;

        let cursorCond: ReturnType<typeof and> | undefined;
        if (cursor) {
          try {
            const { updatedAt, id } = decodeSessionCursor(cursor);
            cursorCond = or(
              lt(sessions.updatedAt, updatedAt),
              and(eq(sessions.updatedAt, updatedAt), lt(sessions.id, id)),
            );
          } catch {
            return reply.code(400).send({ error: "invalid cursor" });
          }
        }

        const rows = await db.query.sessions.findMany({
          where: cursorCond
            ? and(eq(sessions.accountId, accountId), cursorCond)
            : eq(sessions.accountId, accountId),
          orderBy: [desc(sessions.updatedAt), desc(sessions.id)],
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor = hasMore && last ? encodeSessionCursor(last.updatedAt, last.id) : null;

        // known-issues.md #8: before handing back `status: "active"` rows,
        // flip any that are actually orphaned (owning machine gone stale,
        // no recent activity either) — lazy, on-read reconciliation, see
        // `staleSessions.ts`.
        const referencedMachineIds = [
          ...new Set(
            page
              .filter((row) => row.status === "active" && row.machineId)
              .map((row) => row.machineId as string),
          ),
        ];
        const machineLastSeenById = new Map<string, Date | null>();
        if (referencedMachineIds.length > 0) {
          const machineRows = await db.query.machines.findMany({
            where: and(
              eq(machines.accountId, accountId),
              inArray(machines.id, referencedMachineIds),
            ),
          });
          for (const machine of machineRows) {
            machineLastSeenById.set(machine.id, machine.lastSeenAt);
          }
        }
        const reconciledPage = await reconcileStaleSessions(
          db,
          eventRouter,
          pushDispatcher,
          reply,
          accountId,
          page,
          machineLastSeenById,
        );

        return { sessions: reconciledPage.map(toSessionRow), nextCursor };
      },
    );
  };
}
