import { decodeBase64 } from "@kvy/crypto";
import { type EncryptedBox, EncryptedBoxSchema, WorkspaceRowSchema } from "@kvy/wire";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { decodeBox, encodeBox } from "../../db/box.js";
import { workspaces } from "../../db/schema.js";
import { allocHeaderSeq } from "../../db/seq.js";
import type { Database } from "../../db/types.js";
import type { EventRouterPort } from "../events/eventRouter.js";
import { toWorkspaceRow } from "./mappers.js";
import { NotFoundSchema } from "./shared.js";

const CreateWorkspaceBodySchema = z.object({
  path: z.string().min(1),
  metadata: EncryptedBoxSchema,
  dek: z.string().min(1), // base64
});

const WorkspaceIdParamsSchema = z.object({ id: z.string().min(1) });

const CasBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  value: EncryptedBoxSchema,
});
const CasResponseSchema = z.object({ version: z.number() });
const CasConflictSchema = z.object({
  current: z.object({ value: EncryptedBoxSchema, version: z.number() }),
});

/**
 * `POST /v1/workspaces` + `PUT /v1/workspaces/:id/metadata` — server-synced
 * home for a workspace's `baseBranch`/`remote` config (docs conversation:
 * "why don't we store this in the workspaces table"). `path` is the
 * create-or-get idempotency key, mirroring `sessions`'s `(accountId, tag)` —
 * it's already sent in the clear elsewhere (`SessionRow.workspaceId`), so
 * using it as a plaintext lookup column here loses no confidentiality.
 * `metadata` stays an opaque, client-encrypted `EncryptedBox` throughout —
 * this server never decrypts it, same as every other synced entity.
 */
export function buildWorkspacesRoutes(
  db: Database,
  eventRouter: EventRouterPort,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/v1/workspaces",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
        schema: {
          body: CreateWorkspaceBodySchema,
          response: { 200: WorkspaceRowSchema, 201: WorkspaceRowSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { path, metadata, dek } = req.body;

        // Create-or-get by (accountId, path) — idempotent, same shape as
        // `POST /v1/sessions`'s (accountId, tag) dedup.
        const outcome = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(workspaces)
            .values({
              accountId,
              path,
              metadata: encodeBox(metadata),
              dek: decodeBase64(dek),
            })
            .onConflictDoNothing({ target: [workspaces.accountId, workspaces.path] })
            .returning();

          if (inserted) {
            const headerSeq = await allocHeaderSeq(tx, accountId);
            return { row: inserted, created: true as const, headerSeq };
          }

          const existing = await tx.query.workspaces.findFirst({
            where: and(eq(workspaces.accountId, accountId), eq(workspaces.path, path)),
          });
          if (!existing) {
            throw new Error(
              `POST /v1/workspaces: conflict on (accountId, path=${path}) but no existing row found`,
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
                body: { t: "workspace-new", workspace: toWorkspaceRow(outcome.row) },
              },
            });
          });
          reply.code(201);
        }
        return toWorkspaceRow(outcome.row);
      },
    );

    app.put(
      "/v1/workspaces/:id/metadata",
      {
        preHandler: app.authenticate,
        config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
        schema: {
          params: WorkspaceIdParamsSchema,
          body: CasBodySchema,
          response: { 200: CasResponseSchema, 404: NotFoundSchema, 409: CasConflictSchema },
        },
      },
      async (req, reply) => {
        const accountId = req.accountId;
        const { id } = req.params;
        const { expectedVersion, value } = req.body;

        const outcome = await db.transaction(async (tx) => {
          const workspace = await tx.query.workspaces.findFirst({
            where: and(eq(workspaces.id, id), eq(workspaces.accountId, accountId)),
          });
          if (!workspace) return { status: "not-found" as const };

          if (workspace.metadataVersion !== expectedVersion) {
            return {
              status: "conflict" as const,
              current: {
                value: decodeBox(workspace.metadata),
                version: workspace.metadataVersion,
              } as { value: EncryptedBox; version: number },
            };
          }

          const [updated] = await tx
            .update(workspaces)
            .set({
              metadata: encodeBox(value),
              metadataVersion: sql`${workspaces.metadataVersion} + 1`,
            })
            .where(
              and(
                eq(workspaces.id, id),
                eq(workspaces.accountId, accountId),
                eq(workspaces.metadataVersion, expectedVersion),
              ),
            )
            .returning();

          if (!updated) {
            const fresh = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
            if (!fresh) {
              throw new Error(
                `PUT /v1/workspaces/:id/metadata: workspace ${id} vanished mid-transaction`,
              );
            }
            return {
              status: "conflict" as const,
              current: {
                value: decodeBox(fresh.metadata),
                version: fresh.metadataVersion,
              } as { value: EncryptedBox; version: number },
            };
          }

          const headerSeq = await allocHeaderSeq(tx, accountId);
          return {
            status: "ok" as const,
            version: updated.metadataVersion,
            headerSeq,
            row: updated,
          };
        });

        if (outcome.status === "not-found") return reply.code(404).send({});
        if (outcome.status === "conflict")
          return reply.code(409).send({ current: outcome.current });

        reply.raw.once("finish", () => {
          eventRouter.emitUpdate({
            accountId,
            payload: {
              seq: outcome.headerSeq,
              ts: Date.now(),
              body: { t: "workspace-update", workspace: toWorkspaceRow(outcome.row) },
            },
          });
        });
        return { version: outcome.version };
      },
    );
  };
}
