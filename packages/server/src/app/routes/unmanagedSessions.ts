import { decodeBase64 } from "@falcon/crypto";
import { EncryptedBoxSchema, UnmanagedSessionRowSchema } from "@falcon/wire";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { encodeBox } from "../../db/box.js";
import { machines, unmanagedSessions } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { toUnmanagedSessionRow } from "./mappers.js";
import { NotFoundSchema } from "./shared.js";

const UpsertUnmanagedSessionBodySchema = z.object({
  machineId: z.string().min(1),
  workspaceId: z.string().min(1),
  providerRef: z.string().min(1),
  summary: EncryptedBoxSchema, // enc: title, lastActivity, running?
  dek: z.string().min(1), // wrapped DEK, base64 (design §5.1)
});

/**
 * `POST /v1/unmanaged-sessions` — upsert-by-`(machineId, providerRef)` for
 * the daemon transcript indexer (plan.md §16 "3.3 Session adoption (UC9)",
 * falcon-system-design.md §8 "Transcript indexer (adoption Tier 1)"). Every
 * indexer tick re-encrypts the summary under a freshly-minted DEK and POSTs
 * it here; the unique index on `(machine_id, provider_ref)` (schema.ts) is
 * the actual dedup mechanism, so this is a plain last-write-wins upsert, not
 * a CAS-versioned update like `machines.ts` — this row has no client-visible
 * version to race over (only the daemon writes it, at most once per
 * `debounceMs` tick per session), and `adopt.take` (a separate, later task)
 * updates it too but does so terminally (marking it adopted), not
 * concurrently with the indexer for the same row.
 *
 * `machineId` must belong to the caller's account — same ownership check as
 * `machines.ts`'s CAS update path — so one account can never plant rows
 * against another account's machine.
 */
export function buildUnmanagedSessionsRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/unmanaged-sessions",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
        schema: {
          body: UpsertUnmanagedSessionBodySchema,
          response: {
            200: UnmanagedSessionRowSchema,
            201: UnmanagedSessionRowSchema,
            404: NotFoundSchema,
          },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { machineId, workspaceId, providerRef, summary, dek } = req.body;

        const machine = await db.query.machines.findFirst({
          where: and(eq(machines.id, machineId), eq(machines.accountId, accountId)),
        });
        if (!machine) return reply.code(404).send({});

        const outcome = await db.transaction(async (tx) => {
          const existing = await tx.query.unmanagedSessions.findFirst({
            where: and(
              eq(unmanagedSessions.machineId, machineId),
              eq(unmanagedSessions.providerRef, providerRef),
            ),
          });

          if (!existing) {
            const [inserted] = await tx
              .insert(unmanagedSessions)
              .values({
                accountId,
                machineId,
                workspaceId,
                providerRef,
                summary: encodeBox(summary),
                dek: decodeBase64(dek),
              })
              .returning();
            if (!inserted) {
              throw new Error("POST /v1/unmanaged-sessions: insert returned no row");
            }
            const headerSeq = await allocHeaderSeq(tx, accountId);
            return { created: true as const, row: inserted, headerSeq };
          }

          const [updated] = await tx
            .update(unmanagedSessions)
            .set({
              workspaceId,
              summary: encodeBox(summary),
              dek: decodeBase64(dek),
              updatedAt: new Date(),
            })
            .where(eq(unmanagedSessions.id, existing.id))
            .returning();
          if (!updated) {
            throw new Error("POST /v1/unmanaged-sessions: update returned no row");
          }
          const headerSeq = await allocHeaderSeq(tx, accountId);
          return { created: false as const, row: updated, headerSeq };
        });

        reply.raw.once("finish", () => {
          eventRouter.emitUpdate({
            accountId,
            payload: {
              seq: outcome.headerSeq,
              ts: Date.now(),
              body: {
                t: outcome.created ? "unmanaged-new" : "unmanaged-update",
                item: toUnmanagedSessionRow(outcome.row),
              },
            },
          });
        });

        reply.code(outcome.created ? 201 : 200);
        return toUnmanagedSessionRow(outcome.row);
      },
    );
  };
}
