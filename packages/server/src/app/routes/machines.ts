import { decodeBase64 } from "@falcon/crypto";
import { EncryptedBoxSchema, MachineRowSchema } from "@falcon/wire";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { decodeBox, encodeBox } from "../../db/box.js";
import { deviceSessions, machines } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { computeMachineNeedsReauth } from "../machineReauth.js";
import { toMachineRow } from "./mappers.js";
import { NotFoundSchema } from "./shared.js";

const MachineFieldSchema = z.object({
  value: EncryptedBoxSchema,
  expectedVersion: z.number().int().nonnegative(),
});

const RegisterMachineBodySchema = z.object({
  // Absent ⇒ register a new machine; present ⇒ update an existing one owned
  // by the caller's account.
  machineId: z.string().min(1).optional(),
  // Wrapped DEK (base64) — required when registering, ignored on update
  // (rotating a machine's DEK is out of scope for this route).
  dek: z.string().min(1).optional(),
  metadata: MachineFieldSchema,
  daemonState: MachineFieldSchema.optional(),
});

const MachineConflictSchema = z.object({
  current: z.object({
    metadata: z.object({ value: EncryptedBoxSchema, version: z.number() }),
    daemonState: z.object({ value: EncryptedBoxSchema, version: z.number() }).nullable(),
  }),
});

/**
 * `POST /v1/machines` — register-or-update, encrypted + versioned metadata/
 * daemonState (design §4.3/§6.1: "register/update (encrypted metadata +
 * daemonState, versioned)"). Registering (no `machineId`) is a plain insert
 * — there's no existing row to race against, so no CAS check applies.
 * Updating (`machineId` present) is the same optimistic-concurrency CAS as
 * the session metadata/state routes, applied independently to `metadata`
 * and — if included in the request — `daemonState`.
 */
export function buildMachinesRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/machines",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: RegisterMachineBodySchema,
          response: {
            200: MachineRowSchema,
            201: MachineRowSchema,
            400: z.object({ error: z.string() }),
            404: NotFoundSchema,
            409: MachineConflictSchema,
          },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { machineId, dek, metadata, daemonState } = req.body;

        if (!machineId) {
          if (!dek) {
            return reply
              .code(400)
              .send({ error: "dek is required when registering a new machine" });
          }

          const outcome = await db.transaction(async (tx) => {
            const [inserted] = await tx
              .insert(machines)
              .values({
                accountId,
                metadata: encodeBox(metadata.value),
                daemonState: daemonState ? encodeBox(daemonState.value) : null,
                dek: decodeBase64(dek),
                lastSeenAt: new Date(),
              })
              .returning();
            if (!inserted) throw new Error("POST /v1/machines: insert returned no row");
            // AH8 "machine-status-reauth": tie THIS request's own device
            // session to the machine it just registered — `issueSession`'s
            // pairing/login call sites can't set `device_sessions.machineId`
            // themselves (no machine exists yet at pair time), so this is
            // the first point a `cli-daemon` session and "its" machine are
            // ever linked. Only meaningful for the daemon's own auth
            // context; a web-scoped caller (shouldn't happen in practice —
            // only the daemon registers machines) leaves device sessions
            // alone.
            if (req.clientKind === "cli-daemon") {
              await tx
                .update(deviceSessions)
                .set({ machineId: inserted.id })
                .where(
                  and(
                    eq(deviceSessions.id, req.sessionId),
                    eq(deviceSessions.accountId, accountId),
                  ),
                );
            }
            const headerSeq = await allocHeaderSeq(tx, accountId);
            return { row: inserted, headerSeq };
          });

          const needsReauth = await computeMachineNeedsReauth(db, accountId, outcome.row.id);

          reply.raw.once("finish", () => {
            eventRouter.emitUpdate({
              accountId,
              payload: {
                seq: outcome.headerSeq,
                ts: Date.now(),
                body: { t: "machine-new", machine: toMachineRow(outcome.row, needsReauth) },
              },
            });
          });
          reply.code(201);
          return toMachineRow(outcome.row, needsReauth);
        }

        const outcome = await db.transaction(async (tx) => {
          const existing = await tx.query.machines.findFirst({
            where: and(eq(machines.id, machineId), eq(machines.accountId, accountId)),
          });
          if (!existing) return { status: "not-found" as const };

          const metadataMismatch = existing.metadataVersion !== metadata.expectedVersion;
          const daemonStateMismatch =
            daemonState !== undefined &&
            existing.daemonStateVersion !== daemonState.expectedVersion;
          if (metadataMismatch || daemonStateMismatch) {
            return {
              status: "conflict" as const,
              current: {
                metadata: {
                  value: decodeBox(existing.metadata),
                  version: existing.metadataVersion,
                },
                daemonState: existing.daemonState
                  ? { value: decodeBox(existing.daemonState), version: existing.daemonStateVersion }
                  : null,
              },
            };
          }

          const [updated] = await tx
            .update(machines)
            .set(
              daemonState
                ? {
                    metadata: encodeBox(metadata.value),
                    metadataVersion: sql`${machines.metadataVersion} + 1`,
                    daemonState: encodeBox(daemonState.value),
                    daemonStateVersion: sql`${machines.daemonStateVersion} + 1`,
                    lastSeenAt: new Date(),
                  }
                : {
                    metadata: encodeBox(metadata.value),
                    metadataVersion: sql`${machines.metadataVersion} + 1`,
                    lastSeenAt: new Date(),
                  },
            )
            .where(
              and(
                eq(machines.id, machineId),
                eq(machines.accountId, accountId),
                eq(machines.metadataVersion, metadata.expectedVersion),
                ...(daemonState !== undefined
                  ? [eq(machines.daemonStateVersion, daemonState.expectedVersion)]
                  : []),
              ),
            )
            .returning();

          if (!updated) {
            // Lost a race with a concurrent writer between the read above and
            // this UPDATE (another request bumped metadataVersion and/or
            // daemonStateVersion in between) — report the fresh current
            // value/version, not the one we read a moment ago. Mirrors
            // casUpdateSessionField's re-read-on-conflict pattern.
            const fresh = await tx.query.machines.findFirst({
              where: and(eq(machines.id, machineId), eq(machines.accountId, accountId)),
            });
            if (!fresh) {
              throw new Error(`POST /v1/machines: machine ${machineId} vanished mid-transaction`);
            }
            return {
              status: "conflict" as const,
              current: {
                metadata: { value: decodeBox(fresh.metadata), version: fresh.metadataVersion },
                daemonState: fresh.daemonState
                  ? { value: decodeBox(fresh.daemonState), version: fresh.daemonStateVersion }
                  : null,
              },
            };
          }

          // AH8 "machine-status-reauth": same backfill as the register
          // branch above — an update is just as good a signal that THIS
          // device session is the one currently running as this machine
          // (e.g. re-registering after `falcon auth login` minted a new
          // session for an already-known machine).
          if (req.clientKind === "cli-daemon") {
            await tx
              .update(deviceSessions)
              .set({ machineId: updated.id })
              .where(
                and(eq(deviceSessions.id, req.sessionId), eq(deviceSessions.accountId, accountId)),
              );
          }

          const headerSeq = await allocHeaderSeq(tx, accountId);
          return { status: "ok" as const, row: updated, headerSeq };
        });

        if (outcome.status === "not-found") return reply.code(404).send({});
        if (outcome.status === "conflict")
          return reply.code(409).send({ current: outcome.current });

        const needsReauth = await computeMachineNeedsReauth(db, accountId, outcome.row.id);

        reply.raw.once("finish", () => {
          eventRouter.emitUpdate({
            accountId,
            payload: {
              seq: outcome.headerSeq,
              ts: Date.now(),
              body: { t: "machine-update", machine: toMachineRow(outcome.row, needsReauth) },
            },
          });
        });
        return toMachineRow(outcome.row, needsReauth);
      },
    );
  };
}
