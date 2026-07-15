import { type EncryptedBox, EncryptedBoxSchema } from "@falcon/wire";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { decodeBox, encodeBox } from "../../db/box.js";
import { sessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { NotFoundSchema, SessionIdParamsSchema } from "./shared.js";

const CasBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  value: EncryptedBoxSchema,
});
const CasResponseSchema = z.object({ version: z.number() });
const CasConflictSchema = z.object({
  current: z.object({ value: EncryptedBoxSchema.nullable(), version: z.number() }),
});

type CasField = "metadata" | "agentState";

type CasOutcome =
  | { status: "not-found" }
  | { status: "conflict"; current: { value: EncryptedBox | null; version: number } }
  | { status: "ok"; version: number; headerSeq: number; row: typeof sessions.$inferSelect };

/**
 * Shared optimistic-concurrency core for `PUT .../metadata` and
 * `PUT .../state` (design §4.3: "the `updateMany({ where: { version:
 * expected }})` → `count === 0 ? 409` pattern is identical" between the two
 * — only the target column differs).
 */
async function casUpdateSessionField(
  db: Database,
  params: {
    sessionId: string;
    accountId: string;
    field: CasField;
    expectedVersion: number;
    value: EncryptedBox;
  },
): Promise<CasOutcome> {
  return db.transaction(async (tx) => {
    const session = await tx.query.sessions.findFirst({
      where: and(eq(sessions.id, params.sessionId), eq(sessions.accountId, params.accountId)),
    });
    if (!session) return { status: "not-found" as const };

    const currentVersion =
      params.field === "metadata" ? session.metadataVersion : session.agentStateVersion;
    if (currentVersion !== params.expectedVersion) {
      const currentRaw = params.field === "metadata" ? session.metadata : session.agentState;
      return {
        status: "conflict" as const,
        current: { value: currentRaw ? decodeBox(currentRaw) : null, version: currentVersion },
      };
    }

    const encoded = encodeBox(params.value);
    const versionColumn = params.field === "metadata" ? sessions.metadataVersion : sessions.agentStateVersion;

    const [updated] = await tx
      .update(sessions)
      .set(
        params.field === "metadata"
          ? { metadata: encoded, metadataVersion: sql`${sessions.metadataVersion} + 1`, updatedAt: new Date() }
          : { agentState: encoded, agentStateVersion: sql`${sessions.agentStateVersion} + 1`, updatedAt: new Date() },
      )
      .where(
        and(
          eq(sessions.id, params.sessionId),
          eq(sessions.accountId, params.accountId),
          eq(versionColumn, params.expectedVersion),
        ),
      )
      .returning();

    if (!updated) {
      // Lost a race with a concurrent writer between the read above and this
      // UPDATE (another request bumped the version in between) — report the
      // fresh current value/version, not the one we read a moment ago.
      const fresh = await tx.query.sessions.findFirst({ where: eq(sessions.id, params.sessionId) });
      if (!fresh) {
        throw new Error(`casUpdateSessionField: session ${params.sessionId} vanished mid-transaction`);
      }
      const freshVersion = params.field === "metadata" ? fresh.metadataVersion : fresh.agentStateVersion;
      const freshRaw = params.field === "metadata" ? fresh.metadata : fresh.agentState;
      return {
        status: "conflict" as const,
        current: { value: freshRaw ? decodeBox(freshRaw) : null, version: freshVersion },
      };
    }

    const headerSeq = await allocHeaderSeq(tx, params.accountId);
    const newVersion = params.field === "metadata" ? updated.metadataVersion : updated.agentStateVersion;
    return { status: "ok" as const, version: newVersion, headerSeq, row: updated };
  });
}

/**
 * `PUT /v1/sessions/:id/metadata` + `PUT /v1/sessions/:id/state` (design
 * §4.3 — ported from Happy's WS `update-metadata`/`update-state` handlers,
 * `sessionUpdateHandler.ts:13,75`, as HTTP CAS).
 */
export function buildSessionCasRoutes(db: Database, eventRouter: EventRouterPort): FastifyPluginAsyncZod {
  return async (app) => {
    for (const [path, field] of [
      ["/v1/sessions/:id/metadata", "metadata"],
      ["/v1/sessions/:id/state", "agentState"],
    ] as const) {
      app.put(
        path,
        {
          preHandler: app.authenticate,
          config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
          schema: {
            params: SessionIdParamsSchema,
            body: CasBodySchema,
            response: { 200: CasResponseSchema, 404: NotFoundSchema, 409: CasConflictSchema },
          },
        },
        async (req, reply) => {
          const accountId = req.accountId;
          const { id } = req.params;
          const outcome = await casUpdateSessionField(db, {
            sessionId: id,
            accountId,
            field,
            expectedVersion: req.body.expectedVersion,
            value: req.body.value,
          });

          if (outcome.status === "not-found") return reply.code(404).send({});
          if (outcome.status === "conflict") return reply.code(409).send({ current: outcome.current });

          reply.raw.once("finish", () => {
            eventRouter.emitUpdate({
              accountId,
              recipientFilter: { type: "all-interested-in-session", sessionId: id },
              payload: {
                seq: outcome.headerSeq,
                ts: Date.now(),
                body: {
                  t: "session-update",
                  id,
                  ...(field === "metadata"
                    ? { metadata: { value: req.body.value, version: outcome.version } }
                    : { agentState: { value: req.body.value, version: outcome.version } }),
                },
              },
            });
          });
          return { version: outcome.version };
        },
      );
    }
  };
}
